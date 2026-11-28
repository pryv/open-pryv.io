/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { getConfigSync } from '@pryv/boiler';
import { ledgerKey, usernameHash } from '../erasureLedger/index.ts';

/**
 * Account names in the platform trail: a username is never stored in clear
 * (the trail outlives the accounts it names and is outside their erasure),
 * only its keyed hash under the erasure ledger's key, the same value as the
 * ledger's `usernameHash` (linkable on purpose). A record part that holds a
 * hash also holds `hashKeyId`, the id of the key that made it: after a key
 * change (an explicit `accountErasure.ledger.hmacKey` set, or the admin key
 * rotated without one) older records are recognised as made with another key.
 */

type ConfigReader = { get: (key: string) => unknown };

/** Keys of a record part that hold a username, and the key of their hash. */
export const ACCOUNT_NAME_KEYS: Readonly<Record<string, string>> = Object.freeze({
  username: 'usernameHash',
  delegateUsername: 'delegateUsernameHash'
});

/**
 * Keys of a record part that hold a part of a username (a search prefix):
 * recorded as `true` (a filter was used). The keyed hash of a few letters
 * would say nothing useful and could be enumerated by whoever holds the key.
 */
export const ACCOUNT_NAME_PART_KEYS: readonly string[] = Object.freeze(['search']);

/** The field naming the key of the hashes of a record part. */
export const HASH_KEY_ID_FIELD = 'hashKeyId';

/** The keyed hash of a username and the id of its key; null when no key is available. */
export function accountNameHash (name: string, config?: ConfigReader): { hash: string; keyId: string } | null {
  try {
    const k = ledgerKey(config ?? getConfigSync());
    return { hash: usernameHash(k, name), keyId: k.keyId };
  } catch {
    return null;
  }
}

/**
 * A record part with every username replaced by its keyed hash, plus the
 * key's id (`hashKeyId`), and every part of a username by `true`. Without a
 * key, the name is left out.
 */
export function scrubAccountNames<T extends Record<string, unknown> | undefined> (part: T, config?: ConfigReader): T {
  if (part == null || typeof part !== 'object') return part;
  let out: Record<string, unknown> | null = null;
  for (const key of ACCOUNT_NAME_PART_KEYS) {
    if (!Object.hasOwn(part, key)) continue;
    out ??= { ...part };
    const value = out[key];
    if (value != null && value !== '' && value !== true) out[key] = true;
  }
  for (const [key, hashKey] of Object.entries(ACCOUNT_NAME_KEYS)) {
    if (!Object.hasOwn(part, key)) continue;
    out ??= { ...part };
    const value = out[key];
    delete out[key];
    if (typeof value === 'string' && value !== '') {
      const named = accountNameHash(value, config);
      if (named != null) {
        out[hashKey] = named.hash;
        out[HASH_KEY_ID_FIELD] = named.keyId;
      }
    }
  }
  return (out ?? part) as T;
}
