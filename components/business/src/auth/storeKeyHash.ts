/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Keyed hash for the store keys built from a client address or an email: the
 * failed-password and password-reset budgets, the /reg/access creation budget,
 * the email challenges and verification-mail slots (platform database), and the
 * per-address budgets and markers of the unauthenticated routes (cluster store).
 * A listing of those keys under a plain sha256 is reversed by enumerating
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
import { getConfigSync, getLogger } from '@pryv/boiler';
import { deriveKey } from '../acme/AtRestEncryption.ts';

export const STORE_KEY_HASH_PURPOSE = 'store-key-hash-v1';

let cached: { secret: string, key: Buffer } | null = null;
let fallbackWarned = false;

// A server does not boot without the setting, so only a process whose config
// is not loaded reaches the fallback; it would compute other keys than its
// siblings (a budget or a code not found), hence the warning.
function warnFallbackOnce (): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  try {
    getLogger('store-key-hash').warn('auth.adminAccessKey is not readable in this process: store keys built from ' +
      'client addresses and emails use an unkeyed sha256 here, unlike the other processes of the platform.');
  } catch { /* no logger yet either */ }
}

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
  if (key == null) {
    warnFallbackOnce();
    return createHash('sha256').update(value).digest('hex');
  }
  return createHmac('sha256', key).update(value).digest('hex');
}
