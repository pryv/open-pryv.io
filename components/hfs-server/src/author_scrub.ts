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
