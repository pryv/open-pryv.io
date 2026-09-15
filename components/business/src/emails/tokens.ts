/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Secret helpers shared by the email flows: the account verification token and
 * the registration proof. One implementation, so both flows mint at the same
 * strength and compare the same way.
 *
 * The plaintext value lives only in memory, long enough to be mailed or
 * returned to the caller; only its hash is ever persisted.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Mint a 256-bit URL-safe secret (a verification token or a registration proof). */
export function mintToken (): string {
  return randomBytes(32).toString('base64url');
}

/** Hex sha256 of a secret: the only form ever stored. */
export function hashToken (token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare of two hex sha256 digests; false on length mismatch. */
export function hashEquals (a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
