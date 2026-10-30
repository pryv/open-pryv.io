/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth sessions under a consent grant: what a session may still use, and
 * the re-cut of the live sessions when the grant changes.
 *
 * A session access names its grant (`clientData.oauth.dataGrantId`). When the
 * grant's permissions change (a re-consent narrowing it, or the owner editing
 * it), each live session is brought to what the new grant still covers, at
 * once, instead of keeping its reach until the next refresh: the session row
 * is rewritten storage-direct (it is ephemeral: the grant, changed through
 * `accesses.update`, is the consent record), its token leaves every worker's
 * access cache, and the change is notified. A session left with no reach is
 * deleted with what it created, which also ends its refresh chain. Refresh
 * rows keep their chain's permissions: the next refresh computes the same
 * result.
 */

import cache from 'cache';
import timestamp from 'unix-timestamp';
import { fromCallback } from 'utils';
import { pubsub, USERNAME_BASED_ACCESSES_CHANGED } from 'messages';
import { getStorageLayer } from 'storage';
import AccessLogic from 'business/src/accesses/AccessLogic.ts';
import { mergeStreamPermissions } from 'business/src/accesses/permissionSet.ts';
import { parseAccessRef } from 'business/src/accesses/refs.ts';
import { deleteAccessChain, notifyScopedAccessChange } from './accessDeletion.ts';
import { withSessionSelfRevoke, samePermissionKeys } from '../../routes/oauth2/types.ts';

type PermissionEntry = Record<string, unknown>;
type SessionUser = { id: string; username: string };
type AccessRow = {
  id: string;
  type?: string;
  token?: string;
  expires?: number | null;
  permissions?: PermissionEntry[];
  clientData?: { oauth?: { dataGrantId?: unknown } } | null;
};
type NodeCallback = (err: Error | null, result?: unknown) => void;

const dbFindOptions = { projection: { calls: 0, deleted: 0 } };

/**
 * What a session of `grant` may use, given its chain's permissions: the two
 * met stream by stream (a stream narrowed on the grant is narrowed on the
 * session, the grant's forbidden features reach it), then completed with the
 * stream tree, as accesses.create does for a child access: a narrower entry
 * of the grant (an exclusion mask, a carve-out the owner added below a stream
 * the session keeps) and a narrower entry of the chain's own consent (a child
 * the grant no longer lists, under a broader parent) are appended at their
 * narrower level. Both passes only narrow and skip the streams the meet
 * already holds, so their order does not matter. `hasReach` is false when no
 * stream is left above `none` (a mask alone is no reach); the tree passes are
 * then skipped (they never create reach).
 */
export async function effectiveSessionPermissions (
  userId: string, grant: { permissions?: PermissionEntry[] } & Record<string, unknown>, chainPermissions: PermissionEntry[]
): Promise<{ permissions: PermissionEntry[]; hasReach: boolean }> {
  const effective = mergeStreamPermissions(chainPermissions, grant.permissions ?? [], 'meet').permissions as unknown as PermissionEntry[];
  const hasReach = effective.some((p) => typeof p.streamId === 'string' && p.level !== 'none');
  if (!hasReach) return { permissions: effective, hasReach };
  await new AccessLogic(userId, grant).inheritCarveOuts({ permissions: effective as never });
  await new AccessLogic(userId, { id: 'oauth-refresh-chain', type: 'app', permissions: chainPermissions })
    .inheritCarveOuts({ permissions: effective as never });
  return { permissions: effective, hasReach };
}

// The repository's `find` returns live head rows only (it adds `deleted:
// null` and `headId: null` to every query), so a soft-deleted row never
// reaches here; `deleted` is not even projected.
function isLiveSessionOf (access: AccessRow, grantBaseId: string, now: number): boolean {
  return access?.type === 'app' && access.clientData?.oauth?.dataGrantId === grantBaseId &&
    !(access.expires != null && now > access.expires);
}

/**
 * Bring every live session of the grant `grantId` to what the grant covers
 * now. Resolves to the counts of sessions rewritten and deleted.
 */
export async function reconcileSessionsOfGrant (user: SessionUser, grantId: string): Promise<{ updated: number; deleted: number }> {
  const storageLayer = await getStorageLayer();
  const accessesRepository = storageLayer.accesses;
  const base = parseAccessRef(grantId).base;
  const grant = await fromCallback((cb: NodeCallback) =>
    accessesRepository.findOne(user, { id: base }, dbFindOptions, cb)) as AccessRow | null;
  if (grant == null) return { updated: 0, deleted: 0 };
  const now = timestamp.now();
  const all = await fromCallback((cb: NodeCallback) => accessesRepository.find(user, {}, dbFindOptions, cb)) as AccessRow[];
  const sessions = (all ?? []).filter((a) => isLiveSessionOf(a, base, now));
  let updated = 0;
  let deleted = 0;
  for (const session of sessions) {
    // The row carries the session's own selfRevoke override: the chain is
    // what the consent granted, without it.
    const chain = (session.permissions ?? []).filter((p) => p?.feature !== 'selfRevoke');
    const eff = await effectiveSessionPermissions(user.id, grant as AccessRow & Record<string, unknown>, chain);
    if (!eff.hasReach) {
      await deleteAccessChain(user, { id: session.id });
      deleted++;
      continue;
    }
    if (samePermissionKeys(chain, eff.permissions.filter((p) => p.feature !== 'selfRevoke'))) continue;
    const permissions = withSessionSelfRevoke(eff.permissions);
    await fromCallback((cb: NodeCallback) =>
      accessesRepository.updateOne(user, { id: session.id }, { permissions, modified: timestamp.now() }, cb));
    if (typeof session.token === 'string') cache.unsetAccessLogic(user.id, { id: session.id, token: session.token });
    notifyScopedAccessChange(user.username, { id: session.id, type: 'app', permissions: permissions as Array<{ streamId?: string }> }, 'update');
    updated++;
  }
  if (updated > 0) pubsub.notifications.emit(user.username, USERNAME_BASED_ACCESSES_CHANGED);
  return { updated, deleted };
}
