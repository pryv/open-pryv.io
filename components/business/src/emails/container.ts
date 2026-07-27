/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Multiple emails, container operations.
 *
 * The container is an ordinary local-store stream (`:_emails:`) holding one
 * event per email. These helpers are the only sanctioned writers: they reach
 * the mall directly, bypassing the events-API guards that reject hand-made
 * writes into the namespace. Callers (the account methods and registration)
 * own the PlatformDB uniqueness rows and the legacy singular-email field; this
 * module owns the container events and exposes the platform-row primitives it
 * shares with them for convenience.
 */

import * as C from './constants.ts';

import { getMall } from 'mall';
import { getPlatform } from 'platform';
import { getConfig } from '@pryv/boiler';
import timestamp from 'unix-timestamp';

type EmailView = {
  value: string;
  primary: boolean;
  status: string;
  verifiedAt: number | null;
  verificationMethod: string | null;
};

/**
 * Raw stored content of a container event. Extends the public {@link EmailView}
 * with the internal verification-token fields: a
 * pending email carries the sha256 HASH of its emailed token (never the token
 * itself), the token's expiry, and the last-sent timestamp for resend cooldown.
 * These NEVER reach {@link toView} — a personal token reading raw content sees
 * only the preimage-resistant hash, and cannot write the guarded namespace, so
 * self-verification without inbox control stays impossible.
 */
type EmailRecordContent = EmailView & {
  verificationTokenHash?: string | null;
  verificationTokenExpires?: number | null;
  verificationSentAt?: number | null;
};

type EventLike = {
  id: string;
  streamIds: string[];
  type: string;
  content: EmailRecordContent;
  time?: number;
  modified?: number;
  modifiedBy?: string;
  createdBy?: string;
};

const SYSTEM_ACCESS_ID = 'system';

/** Operator cap on emails per account, clamped to the hard ceiling. */
async function getMaxEmails (): Promise<number> {
  const config = await getConfig();
  const raw = config.get('account:maxEmails');
  const n = typeof raw === 'number' && Number.isInteger(raw) ? raw : C.DEFAULT_MAX;
  return Math.max(1, Math.min(n, C.HARD_CAP));
}

/** Verification-token lifetime (ms). Default 24h — the user is not waiting. */
async function getVerificationTokenMaxAgeMs (): Promise<number> {
  const config = await getConfig();
  const raw = config.get('account:emailVerification:tokenMaxAgeMs');
  return typeof raw === 'number' && raw > 0 ? raw : C.DEFAULT_TOKEN_MAX_AGE_MS;
}

/** Minimum delay (ms) between two verification sends for the same email. */
async function getResendCooldownMs (): Promise<number> {
  const config = await getConfig();
  const raw = config.get('account:emailVerification:resendCooldownMs');
  return typeof raw === 'number' && raw >= 0 ? raw : C.DEFAULT_RESEND_COOLDOWN_MS;
}

/** Ensure the reserved container stream exists. Idempotent. */
async function ensureContainerStream (userId: string): Promise<void> {
  const mall = await getMall();
  try {
    await mall.streams.create(userId, {
      id: C.CONTAINER_STREAM_ID,
      parentId: null,
      name: 'Emails',
      clientData: { emails: { kind: 'reserved', autoProvisioned: true } }
    });
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
  }
}

function isAlreadyExistsError (err: unknown): boolean {
  if (err == null) return false;
  const e = err as { message?: string; id?: string; data?: { id?: string } };
  const msg = String(e.message || err);
  if (msg.includes('already exists') || msg.includes('item-already-exists')) return true;
  if (e.id === 'item-already-exists') return true;
  if (e.data?.id === 'item-already-exists') return true;
  return false;
}

/** All raw container events, most recent first. */
async function getRawEvents (userId: string): Promise<EventLike[]> {
  const mall = await getMall();
  const events = await mall.events.get(userId, {
    state: 'all',
    streams: [{ any: [C.CONTAINER_STREAM_ID] }]
  });
  return events as EventLike[];
}

/** The raw container event holding `value`, or null. */
async function findRawByValue (userId: string, value: string): Promise<EventLike | null> {
  const events = await getRawEvents(userId);
  return events.find((e) => e.content?.value === value) ?? null;
}

/** Project a stored event to its public view. */
function toView (event: EventLike): EmailView {
  const c = event.content;
  return {
    value: c.value,
    primary: c.primary === true,
    status: c.status,
    verifiedAt: c.verifiedAt ?? null,
    verificationMethod: c.verificationMethod ?? null
  };
}

/**
 * The account's emails as views. Falls back to synthesizing a single verified
 * primary from the legacy field when the container is empty (existing users
 * whose container has not been seeded yet).
 */
async function listViews (userId: string, legacyEmail: string | null | undefined): Promise<EmailView[]> {
  const events = await getRawEvents(userId);
  if (events.length === 0) {
    if (legacyEmail == null) return [];
    return [synthesizeFromLegacy(legacyEmail)];
  }
  return events.map(toView);
}

/** The view a legacy singular email presents as when no container event exists.
 *  It is the account's founding email — asserted at registration trust, not
 *  link-proved (verifiedAt stays null, so it reads as NOT proved). */
function synthesizeFromLegacy (legacyEmail: string): EmailView {
  return {
    value: legacyEmail,
    primary: true,
    status: C.STATUS_VERIFIED,
    verifiedAt: null,
    verificationMethod: C.METHOD_REGISTRATION
  };
}

/** Create one container event. Bypasses the events-API guards by design. */
async function createEmailEvent (userId: string, view: EmailView, byAccessId?: string): Promise<EventLike> {
  const mall = await getMall();
  const by = byAccessId || SYSTEM_ACCESS_ID;
  const event = await mall.events.create(userId, {
    streamIds: [C.CONTAINER_STREAM_ID],
    type: C.EVENT_TYPE,
    content: {
      value: view.value,
      primary: view.primary === true,
      status: view.status,
      verifiedAt: view.verifiedAt ?? null,
      verificationMethod: view.verificationMethod ?? null
    },
    time: timestamp.now(),
    createdBy: by,
    modifiedBy: by
  });
  return event as EventLike;
}

/** Patch a container event's content fields. */
async function setContent (userId: string, event: EventLike, patch: Partial<EmailRecordContent>, byAccessId?: string): Promise<void> {
  const mall = await getMall();
  const by = byAccessId || SYSTEM_ACCESS_ID;
  const newEvent = {
    ...event,
    content: { ...event.content, ...patch },
    modified: timestamp.now(),
    modifiedBy: by
  };
  await mall.events.update(userId, newEvent);
}

/** Hard-delete a container event. */
async function deleteEmailEvent (userId: string, event: EventLike): Promise<void> {
  const mall = await getMall();
  await mall.events.delete(userId, event);
}

// ---------------- PlatformDB uniqueness rows (shared `email` field) ----------

/** Reserve `(email, value)` for the user. False when another user owns it. */
async function reserveRow (username: string, value: string): Promise<boolean> {
  const platform = await getPlatform();
  return await platform.reserveUserUniqueValue(username, C.UNIQUE_FIELD, value);
}

/** Release `(email, value)` if owned by the user. */
async function releaseRow (username: string, value: string): Promise<boolean> {
  const platform = await getPlatform();
  return await platform.releaseUserUniqueValue(username, C.UNIQUE_FIELD, value);
}

// ---------------- Seeding / verification ------------------------------------

/**
 * Seed the initial container event at registration: the account's first email
 * is primary and verified at today's trust level (no verification method).
 * The PlatformDB row for the value is already owned by the user (created by the
 * registration insert), so this reserves nothing.
 */
async function seedInitial (userId: string, value: string, byAccessId?: string): Promise<void> {
  await ensureContainerStream(userId);
  await createEmailEvent(userId, {
    value,
    primary: true,
    status: C.STATUS_VERIFIED,
    verifiedAt: null,
    verificationMethod: C.METHOD_REGISTRATION
  }, byAccessId);
}

/**
 * Flip a pending email to verified and CLEAR its verification-token fields in
 * the same patch (a verified email holds no live token). The public verify
 * endpoint is the sanctioned caller once it has matched the token; it is also a
 * test/operator seam. NEVER wire it to an unauthenticated path that skips the
 * token match — that would forge verification.
 */
async function markVerified (userId: string, value: string, method: string): Promise<boolean> {
  const event = await findRawByValue(userId, value);
  if (event == null) return false;
  await setContent(userId, event, {
    status: C.STATUS_VERIFIED,
    verifiedAt: timestamp.now(),
    verificationMethod: method,
    verificationTokenHash: null,
    verificationTokenExpires: null,
    verificationSentAt: null
  });
  return true;
}

/**
 * Stamp a freshly-minted verification token onto a pending event: the token
 * HASH (never the token), its expiry, and the send timestamp (for cooldown).
 * Rotating overwrites any previous hash, so old links die.
 */
async function stampVerification (userId: string, event: EventLike, hash: string, expires: number, sentAt: number): Promise<void> {
  await setContent(userId, event, {
    verificationTokenHash: hash,
    verificationTokenExpires: expires,
    verificationSentAt: sentAt
  });
}

export {
  getMaxEmails,
  getVerificationTokenMaxAgeMs,
  getResendCooldownMs,
  ensureContainerStream,
  getRawEvents,
  findRawByValue,
  toView,
  listViews,
  synthesizeFromLegacy,
  createEmailEvent,
  setContent,
  deleteEmailEvent,
  reserveRow,
  releaseRow,
  seedInitial,
  markVerified,
  stampVerification
};
export type { EmailView, EmailRecordContent, EventLike };
