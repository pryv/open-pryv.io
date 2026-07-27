/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Multiple emails, account-method operations.
 *
 * These orchestrate the container events and the shared `email` PlatformDB
 * uniqueness rows for the `account.update` `emails` operations object and for
 * the legacy `account.update {email}` compatibility sync. The primary email
 * stays governed by the legacy singular field: setPrimary and the legacy sync
 * reuse the exact same platform + repository swap the legacy path performs, so
 * uniqueness handling for the singular field stays byte-identical.
 */

import * as C from './constants.ts';
import * as container from './container.ts';
import * as storages from 'storages';

import { getPlatform } from 'platform';
import { getLogger } from '@pryv/boiler';
import timestamp from 'unix-timestamp';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Re-reserve a platform row released by the legacy swap, warning if it fails.
 * The swap releases the old primary's row before we re-reserve it; if another
 * account claims that address in the window, the re-reserve fails and the
 * container event now references an address this account no longer owns. That
 * is a rare race; log it so it is diagnosable (the platform-integrity email
 * cross-check also flags the resulting container-without-row state).
 */
async function reReserveOrWarn (username: string, value: string, site: string): Promise<void> {
  const ok = await container.reserveRow(username, value);
  if (!ok) {
    getLogger('business:emails:operations').warn(
      `failed to re-reserve email "${value}" for ${username} during ${site}: the address was taken by another account`);
  }
}

/** The raw cluster-wide PlatformDB (TTL access-state store), read at call time
 *  via the barrel's live-bound export so it reflects the initialized singleton. */
type ThrottleStore = {
  setAccessStateIfAbsent (key: string, value: unknown, expiresAt: number): Promise<boolean>;
  deleteAccessState (key: string): Promise<void>;
};
function getPlatformDB (): ThrottleStore | null {
  const db = storages.platformDB as ThrottleStore | undefined;
  return (db != null && typeof db.setAccessStateIfAbsent === 'function') ? db : null;
}
/** Per-(account, address) send-throttle key. Hashed so no cleartext address
 *  lands in a cluster-wide key. */
function sendSlotKey (userId: string, email: string): string {
  return 'email-verify-sent/' + userId + '/' + hashToken(email.toLowerCase());
}

/**
 * Reserve the right to send a verification mail to `email` for `userId`, atomic
 * first-writer-wins with a cooldown TTL. Returns true when THIS call reserved
 * the slot (send allowed), false when a live slot already exists (a mail went
 * out to this address within the cooldown — skip the send). The marker lives in
 * PlatformDB, NOT on the container event, so it survives remove/re-add and caps
 * the add/remove/re-add mail-bombing loop. Fails OPEN (returns true) when the
 * cooldown is disabled or no platform store is available.
 */
async function reserveSendSlot (userId: string, email: string): Promise<boolean> {
  const cooldownMs = await container.getResendCooldownMs();
  if (cooldownMs <= 0) return true;
  const db = getPlatformDB();
  if (db == null) return true;
  return await db.setAccessStateIfAbsent(sendSlotKey(userId, email), 1, Date.now() + cooldownMs);
}

/** Release a reserved send slot — called when the send actually FAILED, so a
 *  real delivery failure does not burn the cooldown (no mail went out). */
async function releaseSendSlot (userId: string, email: string): Promise<void> {
  const db = getPlatformDB();
  if (db == null) return;
  await db.deleteAccessState(sendSlotKey(userId, email));
}

type ErrorsFactory = {
  invalidOperation (msg?: string, data?: unknown): Error;
  itemAlreadyExists (resource: string, data?: unknown): Error;
};
type UsersRepositoryLike = {
  updateOne (user: unknown, update: Record<string, unknown>, accessId: string): Promise<unknown>;
};
type Deps = { errors: ErrorsFactory; usersRepository: UsersRepositoryLike };
type UserContext = { userId: string; username: string; user: unknown; accessId: string; legacyEmail: string | null };

/** A newly minted verification token paired with the address it verifies. The
 *  plaintext token lives only in memory long enough for the caller to email it;
 *  only its hash is ever persisted. */
type MintedVerification = { value: string; token: string };

/** Mint a 256-bit URL-safe verification token (a secret, not an id). */
function mintToken (): string {
  return randomBytes(32).toString('base64url');
}

/** Hex sha256 of a token — the only form ever stored. */
function hashToken (token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare of two hex sha256 digests. */
function hashEquals (a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Seed the container from the legacy primary on first use (existing users). */
async function ensureSeeded (userId: string, legacyEmail: string | null): Promise<void> {
  await container.ensureContainerStream(userId);
  const events = await container.getRawEvents(userId);
  if (events.length === 0 && legacyEmail != null) {
    await container.createEmailEvent(userId, {
      value: legacyEmail,
      primary: true,
      status: C.STATUS_VERIFIED,
      verifiedAt: null,
      verificationMethod: C.METHOD_REGISTRATION
    });
  }
}

/**
 * The legacy email swap: exactly what `account.update {email}` performs, so the
 * singular field's PlatformDB row handling is identical whether the change
 * comes from the legacy field or from setPrimary.
 */
async function legacyEmailSwap (deps: Deps, ctx: UserContext, oldValue: string | null, newValue: string): Promise<void> {
  const platform = await getPlatform();
  await platform.updateUser(ctx.username, [{
    action: 'update',
    key: 'email',
    value: newValue,
    previousValue: oldValue,
    isUnique: true,
    isActive: true
  }]);
  await deps.usersRepository.updateOne(ctx.user, { email: newValue }, ctx.accessId);
}

/**
 * add: reserve a row + create a pending, non-primary event per value, and stamp
 * a fresh verification token on each. Returns the minted `{ value, token }`
 * pairs so the caller can email them — the plaintext token is never persisted,
 * only its hash. Mailing is the caller's job (the mail transport lives in the
 * api-server layer); a mail failure must NOT roll the add back (resend recovers).
 */
async function addEmails (deps: Deps, ctx: UserContext, values: string[]): Promise<MintedVerification[]> {
  const errors = deps.errors;
  await ensureSeeded(ctx.userId, ctx.legacyEmail);
  const max = await container.getMaxEmails();
  let count = (await container.getRawEvents(ctx.userId)).length;

  const reservedThisCall: string[] = [];
  const createdThisCall: string[] = [];
  const minted: MintedVerification[] = [];
  try {
    const maxAgeMs = await container.getVerificationTokenMaxAgeMs();
    for (const value of values) {
      const present = await container.findRawByValue(ctx.userId, value);
      if (present != null || createdThisCall.includes(value)) {
        throw errors.invalidOperation('This email is already registered on the account.', { email: value });
      }
      if (count >= max) {
        throw errors.invalidOperation(`Maximum number of emails (${max}) reached.`, { maxEmails: max });
      }
      const reserved = await container.reserveRow(ctx.username, value);
      if (!reserved) {
        throw errors.itemAlreadyExists('email', { email: value });
      }
      reservedThisCall.push(value);
      const event = await container.createEmailEvent(ctx.userId, {
        value,
        primary: false,
        status: C.STATUS_PENDING,
        verifiedAt: null,
        verificationMethod: null
      }, ctx.accessId);
      createdThisCall.push(value);
      const token = mintToken();
      await container.stampVerification(
        ctx.userId, event, hashToken(token),
        timestamp.now(maxAgeMs / 1000), timestamp.now());
      minted.push({ value, token });
      count++;
    }
  } catch (err) {
    // Roll back only what this call reserved/created.
    for (const value of createdThisCall) {
      const ev = await container.findRawByValue(ctx.userId, value);
      if (ev != null) await container.deleteEmailEvent(ctx.userId, ev);
    }
    for (const value of reservedThisCall) {
      await container.releaseRow(ctx.username, value);
    }
    throw err;
  }
  return minted;
}

/** remove: refuse the primary; release the row + delete the event per value. */
async function removeEmails (deps: Deps, ctx: UserContext, values: string[]): Promise<void> {
  const errors = deps.errors;
  await ensureSeeded(ctx.userId, ctx.legacyEmail);
  for (const value of values) {
    const ev = await container.findRawByValue(ctx.userId, value);
    if (ev == null) {
      throw errors.invalidOperation('This email is not registered on the account.', { email: value });
    }
    if (ev.content.primary === true) {
      throw errors.invalidOperation('The primary email cannot be removed.', { email: value });
    }
    await container.releaseRow(ctx.username, value);
    await container.deleteEmailEvent(ctx.userId, ev);
  }
}

/**
 * setPrimary: the target must exist and be verified. Swaps the legacy singular
 * field (byte-identical to the legacy path), keeps the old primary as a
 * verified non-primary, and re-reserves the old primary's row (the legacy swap
 * released it). Returns true when the legacy email actually changed.
 */
async function setPrimary (deps: Deps, ctx: UserContext, value: string): Promise<boolean> {
  const errors = deps.errors;
  await ensureSeeded(ctx.userId, ctx.legacyEmail);
  const events = await container.getRawEvents(ctx.userId);
  const target = events.find((e) => e.content.value === value);
  if (target == null) {
    throw errors.invalidOperation('This email is not registered on the account.', { email: value });
  }
  if (target.content.status !== C.STATUS_VERIFIED) {
    throw errors.invalidOperation('Only a verified email can be set as primary.', { email: value });
  }
  if (target.content.primary === true) return false; // already primary

  const current = events.find((e) => e.content.primary === true) ?? null;
  const oldValue = current != null ? current.content.value : ctx.legacyEmail;

  await legacyEmailSwap(deps, ctx, oldValue, value);
  if (oldValue != null && oldValue !== value) {
    await reReserveOrWarn(ctx.username, oldValue, 'setPrimary'); // stays in container
  }
  if (current != null) await container.setContent(ctx.userId, current, { primary: false });
  await container.setContent(ctx.userId, target, { primary: true });
  return true;
}

/**
 * Verify a pending email from its mailed token. Scoped to THIS user's own
 * container events (username came from the request path), so a token minted for
 * another account can never match here. Compares the sha256 of the presented
 * token, constant-time, against each pending event's stored hash; on a live
 * (non-expired) match flips it to verified and clears the token fields.
 * Returns the verified address, or null for every failure mode (unknown token,
 * expired, none pending) so the caller can answer with ONE uniform error.
 */
async function verifyToken (userId: string, token: string): Promise<string | null> {
  if (typeof token !== 'string' || token.length === 0) return null;
  const presented = hashToken(token);
  const now = timestamp.now();
  const events = await container.getRawEvents(userId);
  for (const ev of events) {
    if (ev.content.status !== C.STATUS_PENDING) continue;
    const hash = ev.content.verificationTokenHash;
    if (hash == null) continue;
    if (!hashEquals(hash, presented)) continue;
    const expires = ev.content.verificationTokenExpires;
    if (expires != null && now >= expires) return null; // matched but expired
    await container.markVerified(userId, ev.content.value, C.METHOD_EMAIL_LINK);
    return ev.content.value;
  }
  return null;
}

/**
 * Resend the verification mail for a pending email, enforcing the resend
 * cooldown and ROTATING the token (the old link dies). Returns the new
 * `{ value, token }` for the caller to mail. Throws invalidOperation when the
 * email is unknown, already verified, or still within the cooldown window
 * (with `retryAfterSeconds`).
 */
async function resendVerification (deps: Deps, ctx: UserContext, value: string): Promise<MintedVerification> {
  const errors = deps.errors;
  await ensureSeeded(ctx.userId, ctx.legacyEmail);
  const ev = await container.findRawByValue(ctx.userId, value);
  if (ev == null) {
    throw errors.invalidOperation('This email is not registered on the account.', { email: value });
  }
  if (ev.content.status !== C.STATUS_PENDING) {
    throw errors.invalidOperation('This email is already verified.', { email: value });
  }
  const cooldownMs = await container.getResendCooldownMs();
  const sentAt = ev.content.verificationSentAt;
  const now = timestamp.now();
  if (sentAt != null && cooldownMs > 0) {
    const readyAt = sentAt + cooldownMs / 1000;
    if (now < readyAt) {
      throw errors.invalidOperation('Please wait before requesting another verification email.', {
        email: value, retryAfterSeconds: Math.ceil(readyAt - now)
      });
    }
  }
  const maxAgeMs = await container.getVerificationTokenMaxAgeMs();
  const token = mintToken();
  await container.stampVerification(
    ctx.userId, ev, hashToken(token), timestamp.now(maxAgeMs / 1000), now);
  return { value, token };
}

/**
 * Legacy `account.update {email}` container sync. The legacy path already
 * swapped the singular field and its row; here we mirror the change into the
 * container: promote or create the new value as primary+verified, keep the old
 * primary as a verified non-primary (re-reserving its row), and drop the oldest
 * non-primary if that would exceed the cap.
 */
async function reconcileLegacyPrimaryChange (deps: Deps, ctx: UserContext, oldValue: string | null, newValue: string): Promise<void> {
  if (newValue == null || newValue === oldValue) return;
  await container.ensureContainerStream(ctx.userId);

  let events = await container.getRawEvents(ctx.userId);
  if (events.length === 0 && oldValue != null) {
    // Reconstruct the prior primary so the record is not silently lost. Its
    // row was released by the legacy swap, so re-reserve it. This is the
    // standing founding email — asserted at registration trust, not proved.
    await reReserveOrWarn(ctx.username, oldValue, 'reconcileLegacyPrimaryChange');
    await container.createEmailEvent(ctx.userId, {
      value: oldValue,
      primary: true,
      status: C.STATUS_VERIFIED,
      verifiedAt: null,
      verificationMethod: C.METHOD_REGISTRATION
    }, ctx.accessId);
    events = await container.getRawEvents(ctx.userId);
  }

  const existingNew = events.find((e) => e.content.value === newValue) ?? null;
  if (existingNew != null) {
    const wasVerified = existingNew.content.status === C.STATUS_VERIFIED;
    // A legacy swap does not prove ownership. If the value was already
    // (link/operator/registration) verified, keep its provenance + timestamp;
    // otherwise it is a legacy assertion — verified with no proof, so
    // verifiedAt stays null (only a real verification stamps a time).
    await container.setContent(ctx.userId, existingNew, {
      primary: true,
      status: C.STATUS_VERIFIED,
      verifiedAt: wasVerified ? existingNew.content.verifiedAt : null,
      verificationMethod: wasVerified ? existingNew.content.verificationMethod : C.METHOD_LEGACY,
      // Promoting a pending email to verified retires any live token.
      verificationTokenHash: null,
      verificationTokenExpires: null,
      verificationSentAt: null
    }, ctx.accessId);
  } else {
    // The new value's row is already owned (reserved by the legacy swap). Set
    // by the legacy path with no proof of ownership → asserted, not proved.
    await container.createEmailEvent(ctx.userId, {
      value: newValue,
      primary: true,
      status: C.STATUS_VERIFIED,
      verifiedAt: null,
      verificationMethod: C.METHOD_LEGACY
    }, ctx.accessId);
  }

  // Demote every other primary; keep them verified. Re-reserve the old
  // primary's row since it stays in the container.
  events = await container.getRawEvents(ctx.userId);
  for (const e of events) {
    if (e.content.value === newValue) continue;
    if (e.content.primary === true) {
      // A demoted primary is verified and holds no live token — clear any
      // token fields unconditionally so "verified ⇒ no live token" always holds.
      await container.setContent(ctx.userId, e, {
        primary: false,
        status: C.STATUS_VERIFIED,
        verificationTokenHash: null,
        verificationTokenExpires: null,
        verificationSentAt: null
      }, ctx.accessId);
    }
    if (e.content.value === oldValue) {
      await reReserveOrWarn(ctx.username, oldValue, 'reconcileLegacyPrimaryChange');
    }
  }

  // Enforce the cap: drop the oldest non-primary rather than fail.
  const max = await container.getMaxEmails();
  let all = await container.getRawEvents(ctx.userId);
  while (all.length > max) {
    const nonPrimary = all
      .filter((e) => e.content.primary !== true)
      .sort((a, b) => ((a.time as number) ?? 0) - ((b.time as number) ?? 0));
    if (nonPrimary.length === 0) break;
    const oldest = nonPrimary[0];
    await container.releaseRow(ctx.username, oldest.content.value);
    await container.deleteEmailEvent(ctx.userId, oldest);
    all = await container.getRawEvents(ctx.userId);
  }
}

export {
  addEmails,
  removeEmails,
  setPrimary,
  verifyToken,
  resendVerification,
  reserveSendSlot,
  releaseSendSlot,
  reconcileLegacyPrimaryChange,
  ensureSeeded
};
export type { Deps, UserContext, MintedVerification };
