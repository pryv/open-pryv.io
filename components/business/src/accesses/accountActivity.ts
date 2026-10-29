/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Last activity of an account, as the account holder's own use of it.
 *
 * Activity is the latest `lastUsed` among the account's `personal` and `app`
 * accesses. `shared` accesses are left out on purpose: a third party reading
 * or writing through an access the holder granted (a practitioner, an
 * integration) is not the holder using the account. Deleted accesses are not
 * consulted; a caller that needs a value that never moves backwards keeps its
 * own maximum.
 */

import type { Callback } from 'storages/interfaces/_shared/types.ts';

type UserRef = { id: string; username?: string };
type AccessRow = { type?: string; lastUsed?: number | null };

export type ActivityAccessesRepo = {
  find (user: UserRef, query: Record<string, unknown>, options: Record<string, unknown> | null, callback: Callback<AccessRow[]>): void;
};

export const ACTIVITY_ACCESS_TYPES: readonly string[] = Object.freeze(['personal', 'app']);

/** Latest activity in pryv seconds, or null when no qualifying access was ever used. */
export function lastActivityOf (accesses: AccessRow[]): number | null {
  let latest: number | null = null;
  for (const access of accesses) {
    if (access == null || !ACTIVITY_ACCESS_TYPES.includes(access.type as string)) continue;
    const used = access.lastUsed;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    if (latest == null || used > latest) latest = used;
  }
  return latest;
}

export function getLastActivity (repo: ActivityAccessesRepo, user: UserRef): Promise<number | null> {
  return new Promise((resolve, reject) => {
    repo.find(user, {}, null, (err, accesses) => {
      if (err != null) return reject(err);
      resolve(lastActivityOf(accesses ?? []));
    });
  });
}
