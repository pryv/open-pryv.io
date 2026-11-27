/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The stored form of a deletion notice's `apiEndpoint` (both engines): while
 * the row is pending, the endpoint carries a token of an access on another
 * platform, so it is stored sealed (`sealed:<kid>.<envelope>`, bound to the
 * notice id); a terminal row keeps the credential-free URL in clear. Above
 * the engines `DeletionNoticeRow.apiEndpoint` is always the clear URL; an
 * envelope that does not open reads as an empty endpoint, which the outbox
 * retires unsent.
 */

import type { TokenProtection } from './tokenProtection.ts';
import { isSealedValue } from './tokenProtection.ts';

type Status = string;

/** The envelope context of a notice's endpoint. */
export function noticeContext (id: string): string {
  return 'deletion-notice:' + id;
}

/** The value to store for a row's endpoint. */
export function storedEndpoint (tp: TokenProtection, id: string, status: Status, apiEndpoint: string): string {
  if (status !== 'pending' || typeof apiEndpoint !== 'string' || isSealedValue(apiEndpoint) || apiEndpoint === '') return apiEndpoint;
  return tp.sealSecret(noticeContext(id), apiEndpoint);
}

/** The clear endpoint of a stored value; '' (logged, notice id only) when it does not open. */
export function openedEndpoint (tp: TokenProtection, id: string, stored: string, log: (msg: string) => void): string {
  if (!isSealedValue(stored)) return stored;
  try {
    return tp.openSecret(noticeContext(id), stored);
  } catch (err) {
    log('deletion notice ' + JSON.stringify(id) + ': stored endpoint unreadable, the notice will be retired unsent (' +
      (err as Error).message + ')');
    return '';
  }
}

export type NoticeSealStatus = { clear: number; sealedCurrentKey: number; sealedOtherKeys: Record<string, number> };

/** Counts of the pending rows' endpoints per stored form. */
export function sealedNoticeStatus (tp: TokenProtection, rows: Array<{ status: string; apiEndpoint: string }>): NoticeSealStatus {
  const status: NoticeSealStatus = { clear: 0, sealedCurrentKey: 0, sealedOtherKeys: {} };
  for (const r of rows) {
    if (isSealedValue(r.apiEndpoint)) {
      if (tp.ownsSealed(r.apiEndpoint)) status.sealedCurrentKey++;
      else {
        const kid = r.apiEndpoint.slice('sealed:'.length).split('.')[0];
        status.sealedOtherKeys[kid] = (status.sealedOtherKeys[kid] ?? 0) + 1;
      }
    } else if (r.status === 'pending') status.clear++;
  }
  return status;
}

/** The row with its endpoint re-sealed under `tp` from one of `previous`; null when no key of them owns it. */
export function rekeyedEndpoint (tp: TokenProtection, previous: TokenProtection[], id: string, stored: string): string | null {
  if (!isSealedValue(stored) || tp.ownsSealed(stored)) return null;
  const from = previous.find((p) => p.ownsSealed(stored));
  if (from == null) return null;
  return tp.sealSecret(noticeContext(id), from.openSecret(noticeContext(id), stored));
}
