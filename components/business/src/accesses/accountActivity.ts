/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Last activity of an account: its own use, by the holder or by a delegate.
 *
 * Activity is the latest `lastUsed` among the account's `personal` and `app`
 * accesses. `shared` accesses are left out on purpose: a third party reading
 * or writing through an access the holder granted (a practitioner, an
 * integration) is not someone using the account. A delegate's use (its
 * delegate token, or an app access granted with it) counts, and is reported
 * as `by: 'delegate'`: an account a delegate looks after every day is in use.
 * Deleted accesses are not consulted; a caller that needs a value that never
 * moves backwards keeps its own maximum.
 *
 * A `lastUsed` later than now (plus `ACTIVITY_CLOCK_SKEW_SECONDS`) is not
 * use: the server only ever writes the time of the call, so such a value was
 * planted (storage-direct, an imported archive) and would otherwise keep the
 * account looking active until that date. The allowance covers a clock
 * stepped back after the value was written; it is far below the shortest
 * inactivity period, so it buys nothing.
 */

import type { Callback } from 'storages/interfaces/_shared/types.ts';
import { CLIENTDATA_KIND } from 'delegation/src/constants.ts';

type UserRef = { id: string; username?: string };
type AccessRow = {
  type?: string;
  lastUsed?: number | null;
  clientData?: { delegation?: { kind?: unknown } | null } | null;
};

export type ActivityAccessesRepo = {
  find (user: UserRef, query: Record<string, unknown>, options: Record<string, unknown> | null, callback: Callback<AccessRow[]>): void;
};

/** Times in pryv seconds, null when nothing of that kind was ever used. */
export type AccountActivity = {
  at: number | null;
  by: 'owner' | 'delegate' | null;
  /** The holder's own personal and app accesses, and all delegate use. */
  personal: number | null;
  app: number | null;
  delegate: number | null;
};

export const ACTIVITY_ACCESS_TYPES: readonly string[] = Object.freeze(['personal', 'app']);

const DELEGATE_KINDS: readonly unknown[] = Object.freeze([CLIENTDATA_KIND.DELEGATE_PAT, CLIENTDATA_KIND.DELEGATED_CHILD]);

/** How far past `now` a `lastUsed` may be and still count as use, in seconds. */
export const ACTIVITY_CLOCK_SKEW_SECONDS = 3600;

function later (a: number | null, b: number): number {
  return a == null || b > a ? b : a;
}

function nowSeconds (): number {
  return Date.now() / 1000;
}

/** `now` in pryv seconds; the auto-deletion sweep passes its own clock. */
export function activityOf (accesses: AccessRow[], now: number = nowSeconds()): AccountActivity {
  const res: AccountActivity = { at: null, by: null, personal: null, app: null, delegate: null };
  const latest = now + ACTIVITY_CLOCK_SKEW_SECONDS;
  for (const access of accesses) {
    if (access == null || !ACTIVITY_ACCESS_TYPES.includes(access.type as string)) continue;
    const used = access.lastUsed;
    if (typeof used !== 'number' || !Number.isFinite(used) || used > latest) continue;
    const byDelegate = DELEGATE_KINDS.includes(access.clientData?.delegation?.kind);
    if (byDelegate) {
      res.delegate = later(res.delegate, used);
    } else if (access.type === 'personal') {
      res.personal = later(res.personal, used);
    } else {
      res.app = later(res.app, used);
    }
    if (res.at == null || used > res.at) {
      res.at = used;
      res.by = byDelegate ? 'delegate' : 'owner';
    }
  }
  return res;
}

/** Latest activity in pryv seconds, or null when no qualifying access was ever used. */
export function lastActivityOf (accesses: AccessRow[], now: number = nowSeconds()): number | null {
  return activityOf(accesses, now).at;
}

export function getActivity (repo: ActivityAccessesRepo, user: UserRef, now: number = nowSeconds()): Promise<AccountActivity> {
  return new Promise((resolve, reject) => {
    repo.find(user, {}, null, (err, accesses) => {
      if (err != null) return reject(err);
      resolve(activityOf(accesses ?? [], now));
    });
  });
}

export async function getLastActivity (repo: ActivityAccessesRepo, user: UserRef, now: number = nowSeconds()): Promise<number | null> {
  return (await getActivity(repo, user, now)).at;
}
