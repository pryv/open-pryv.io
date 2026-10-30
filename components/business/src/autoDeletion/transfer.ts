/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Transfer of an account to a beneficiary, the pure part: the links mailed to
 * the beneficiary and when the claim window needs something (a re-sent claim
 * mail, its end). Time comes in as `now`; nothing is read or written here.
 *
 * A link is an HMAC of (kind, account id, salt) under the core's link key: the
 * record keeps the salt only, so a re-sent link is the same link and a
 * database dump holds no usable link. A new salt (a new transfer) invalidates
 * every earlier link.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DAY_SECONDS } from './deadline.ts';
import type { TransferRecord } from './state.ts';

export type LinkKind = 'claim' | 'decline';

/** Days after the window opened when the claim mail is sent again. */
export const CLAIM_RESEND_DAYS: readonly number[] = Object.freeze([30, 60]);

export function newSalt (): string {
  return randomBytes(16).toString('base64url');
}

export function deriveLinkToken (key: Buffer, kind: LinkKind, userId: string, salt: string): string {
  return createHmac('sha256', key).update(kind + ':' + userId + ':' + salt).digest('base64url');
}

/** Constant-time check of a token against the one this record's salt gives. */
export function linkTokenMatches (key: Buffer, kind: LinkKind, userId: string, salt: string | undefined, token: unknown): boolean {
  if (salt == null || typeof token !== 'string' || token.length === 0 || token.length > 200) return false;
  const expected = Buffer.from(deriveLinkToken(key, kind, userId, salt));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The claim mail to send now: `initial` when none was, `resend` when a re-send is due, else null. */
export function claimMailDue (record: TransferRecord, now: number): 'initial' | 'resend' | null {
  if (record.status !== 'open' || record.openedAt == null) return null;
  const sent = record.claimMailsSent ?? [];
  if (sent.length === 0) return 'initial';
  if (record.endsAt != null && now >= record.endsAt) return null;
  const resendsDue = CLAIM_RESEND_DAYS.filter((d) => record.openedAt! + d * DAY_SECONDS <= now).length;
  return sent.length - 1 < resendsDue ? 'resend' : null;
}

/** The claim window is over: the owner's fallback applies (a bound claim not yet accepted included). */
export function windowEnded (record: TransferRecord, now: number): boolean {
  return (record.status === 'open' || record.status === 'claimed') && record.endsAt != null && now >= record.endsAt;
}

/** A link to a page of the account app: `base` may carry a query of its own (kept). */
export function accountAppLink (base: string, page: string, params: Record<string, string>): string {
  const [path, query] = base.split('?', 2);
  const url = (path.endsWith('/') ? path : path + '/') + page;
  const own = new URLSearchParams(query ?? '');
  for (const [k, v] of Object.entries(params)) own.set(k, v);
  return url + '?' + own.toString();
}
