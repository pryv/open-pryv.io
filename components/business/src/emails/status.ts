/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Verification state of an account's email addresses, derived from the
 * reserved container. One definition of "this address is proved", shared by
 * the SSO email matching and the read-only `verification/email` event that
 * accompanies the primary address.
 */

import * as C from './constants.ts';
import { getRawEvents } from './container.ts';
import { normalizeEmail } from './challenge.ts';
import { registerDerivedField } from 'storages/datastores/account/index.ts';

/** Event type of the read-only verification event (data-types `verification/email`). */
export const VERIFICATION_EVENT_TYPE = 'verification/email';
/** Field name of that derived event: id `:system:emailVerification`, in the `:system:email` stream. */
export const VERIFICATION_FIELD = 'emailVerification';

type ContainerEvent = Awaited<ReturnType<typeof getRawEvents>>[number] & { trashed?: boolean };

/** Content of a `verification/email` event. */
export type EmailVerification = {
  verified: boolean;
  method: string | null;
  verifiedAt: number | null;
};

/** Live (non-trashed) container events whose value matches `email` case-insensitively. */
async function findLive (userId: string, email: string): Promise<ContainerEvent[]> {
  const target = normalizeEmail(email);
  const events = await getRawEvents(userId) as ContainerEvent[];
  return events.filter((ev) =>
    ev.trashed !== true &&
    typeof ev.content?.value === 'string' &&
    normalizeEmail(ev.content.value) === target);
}

/**
 * True when `email` is a live address of the account whose ownership was
 * proved (see {@link C.isProvedOwnership}). Case-insensitive, so an address
 * whose case differs from the stored one still matches; a removed address that
 * is not yet released never passes.
 */
export async function isAddressProved (userId: string, email: string): Promise<boolean> {
  return (await findLive(userId, email)).some((ev) => C.isProvedOwnership(ev.content));
}

/**
 * Verification state of the account's primary address `primary`, plus the
 * time the container record last changed (null when the container holds no
 * record for it: an account whose container was never seeded, whose founding
 * address reads as asserted, not proved).
 */
export async function primaryVerification (userId: string, primary: string): Promise<{ content: EmailVerification, modified: number | null }> {
  // the exact value first, then any case variant (a proved one preferred)
  const matches = await findLive(userId, primary);
  const ev = matches.find((e) => e.content.value === primary) ??
    matches.find((e) => C.isProvedOwnership(e.content)) ??
    matches[0];
  if (ev == null) {
    return { content: { verified: false, method: C.METHOD_REGISTRATION, verifiedAt: null }, modified: null };
  }
  return {
    content: {
      verified: C.isProvedOwnership(ev.content),
      method: ev.content.verificationMethod ?? null,
      verifiedAt: ev.content.verifiedAt ?? null
    },
    modified: ev.modified ?? null
  };
}

/**
 * Let API reads of the account email ask for its verification state: a
 * read-only `verification/email` event in the same stream, returned when the
 * request's `types` names it (see AccountUserEvents), derived from the
 * container at read time. Its `time` is the address event's, so the address
 * stays first when both are requested; its `modified` follows the latest of
 * the two changes.
 */
export function registerVerificationEvent (): void {
  registerDerivedField(VERIFICATION_FIELD, {
    baseField: C.UNIQUE_FIELD,
    type: VERIFICATION_EVENT_TYPE,
    provider: async (userId, baseEvent) => {
      if (typeof baseEvent.content !== 'string') return null;
      return await primaryVerification(userId, baseEvent.content);
    }
  });
}
