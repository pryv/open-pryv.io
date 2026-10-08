/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Helper of `bin/hfs-author-scrub.js`: tells whether an event's `modifiedBy`
 * holds an access credential (as written by series ingest before it recorded
 * the access id) and what it should read instead.
 */

export type ScrubAccess = { id: string; type?: string; live: boolean; token: string };

/**
 * Every row a keyset page reader returns, one page in memory at a time.
 * `fetchPage(afterId, limit)` returns up to `limit` rows whose id sorts after
 * `afterId` (null for the first page), in id order; a short page ends it.
 */
export async function * pagedRows<T extends { id: string }> (
  fetchPage: (afterId: string | null, limit: number) => Promise<T[]>,
  pageSize: number
): AsyncGenerator<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('page size must be a positive integer');
  let afterId: string | null = null;
  for (;;) {
    const page = await fetchPage(afterId, pageSize);
    for (const row of page) yield row;
    if (page.length < pageSize) return;
    afterId = page[page.length - 1].id;
  }
}

/**
 * The access-id form of `modifiedBy` when it holds a known token ("<token>",
 * "<token> <callerId>", optionally prefixed by the DPoP scheme), else null.
 * A value that already is an access id is left alone.
 */
export function authorFor (
  modifiedBy: unknown,
  byToken: Map<string, ScrubAccess>,
  accessIds: Set<string>
): { value: string; access: ScrubAccess } | null {
  if (typeof modifiedBy !== 'string' || modifiedBy === '') return null;
  const raw = modifiedBy.replace(/^dpop /i, '');
  const space = raw.indexOf(' ');
  const cred = space === -1 ? raw : raw.slice(0, space);
  const rest = space === -1 ? '' : raw.slice(space);
  if (accessIds.has(cred)) return null;
  const access = byToken.get(cred);
  if (access == null) return null;
  return { value: access.id + rest, access };
}
