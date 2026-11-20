/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Keyed hash for the store keys built from a client address or an email: the
 * failed-password and password-reset budgets, the /reg/access creation budget
 * and the email challenges. Those keys live in the platform database, which
 * every core can list, so a plain sha256 there is reversed by enumerating
 * addresses or running a mailing list through it. An HMAC under a platform-wide
 * secret is not.
 *
 * The HMAC key is HKDF-derived from `auth.adminAccessKey` with its own purpose
 * label. That setting is identical on every core (the bootstrap bundle carries
 * it), so every core computes the same store key for the same input. Rotating
 * it only resets the budgets and challenges in flight.
 *
 * Without the setting (a bare development core), the plain sha256 is used, the
 * same as before.
 */

import { createHash, createHmac } from 'node:crypto';
import { getConfigSync } from '@pryv/boiler';
import { deriveKey } from '../acme/AtRestEncryption.ts';

export const STORE_KEY_HASH_PURPOSE = 'store-key-hash-v1';

let cached: { secret: string, key: Buffer } | null = null;

function currentKey (): Buffer | null {
  let secret: unknown = null;
  // Read per call (config not ready yet: the unkeyed fallback, like a core without the setting).
  try { secret = getConfigSync().get('auth:adminAccessKey'); } catch { secret = null; }
  if (typeof secret !== 'string' || secret.length === 0) return null;
  if (cached?.secret !== secret) cached = { secret, key: deriveKey(secret, STORE_KEY_HASH_PURPOSE) };
  return cached.key;
}

/** Hex HMAC-SHA256 of `value` under the platform's store-key secret (see above). */
export function storeKeyHash (value: string): string {
  const key = currentKey();
  if (key == null) return createHash('sha256').update(value).digest('hex');
  return createHmac('sha256', key).update(value).digest('hex');
}
