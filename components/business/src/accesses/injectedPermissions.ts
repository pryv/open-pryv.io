/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The permissions `AccessLogic` injects into every non-personal access at
 * load time, and how to tell them apart from what an app actually asked for.
 *
 * Two entries are injected (`AccessLogic.ts:105` and `:120`):
 *   - `{ streamId: ':_system:account', level: 'none' }`, which locks the
 *     account streams unless an explicit permission overrides it;
 *   - `{ streamId: ':_audit:access-<accessId>', level: 'read' }`, the
 *     access's own audit trail, unless `selfAudit` is forbidden.
 *
 * They are part of what the SERVER adds, never part of what the app
 * requested, so anything comparing a stored access against a request has to
 * drop them first. `checkApp` learned that the hard way: counting them made
 * every existing app access report as mismatching, which re-prompted the
 * user for consent on every single sign-in. The consent-grant check on the
 * auth-request accept path needs the same subtraction, for a sharper reason:
 * an injected entry is not in the offer, so leaving it in would read as
 * "granted more than offered" and refuse every honest grant.
 *
 * One predicate, both callers, so the two can never drift.
 *
 * Pure module: no config, no I/O.
 */

import { STREAM_ID_ACCOUNT } from '../system-streams/index.ts';

import type { Permission, StreamPermission } from '../types/public.ts';

/**
 * Is this entry one the server injected into `accessId`'s permissions?
 *
 * `accessId` matters: the audit entry names its own access, so an entry
 * pointing at ANOTHER access's audit stream is a real, explicitly granted
 * permission and must not be dropped.
 */
export function isInjectedPermission (permission: Permission, accessId: string | null | undefined): boolean {
  if (permission == null || !('streamId' in permission)) return false;
  const p = permission as StreamPermission;
  if (p.streamId === STREAM_ID_ACCOUNT && p.level === 'none') return true;
  return accessId != null && p.streamId === ':_audit:access-' + accessId && p.level === 'read';
}

/**
 * The permissions of `accessId` minus the injected ones. A personal access
 * (no permissions) yields an empty list rather than throwing: it grants
 * everything, which is never a valid answer to a scoped consent offer.
 */
export function withoutInjectedPermissions (
  permissions: Permission[] | null | undefined,
  accessId: string | null | undefined
): Permission[] {
  if (!Array.isArray(permissions)) return [];
  return permissions.filter((p) => !isInjectedPermission(p, accessId));
}
