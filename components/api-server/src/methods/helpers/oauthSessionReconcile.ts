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
 * A session access names its grant (`clientData.oauth.dataGrantId`) and
 * carries its chain's consent (`clientData.oauth.chain`). Invariant: a live
 * session equals what a refresh of its chain would mint now,
 * `effectiveSessionPermissions(grant, chain)`. When the grant's permissions
 * change (a re-consent, the owner editing it, a CMC scope update), each live
 * session is brought to that at once, instead of at its next refresh: the
 * row is rewritten storage-direct (it is ephemeral: the grant is the consent
 * record), narrowing it or widening it back, never beyond its chain's consent
 * nor beyond the grant; its token leaves every worker's access cache, and the
 * change is notified. A session left with no reach is deleted with what it
 * created; its chain's next refresh is then refused (`invalid_grant`) unless
 * the owner has widened the grant again before it. Refresh rows keep their
 * chain's permissions.
 *
 * The accesses a session created (shared accesses, stamped with the grant at
 * their creation, or, created before the stamp existed, naming a session of
 * the grant as creator) belong to the grant too: after the sessions, each
 * live one is brought within the grant as it now stands. They only ever
 * narrow (their row is their consent: they have no chain to widen back to); one
 * left with no reach is deleted with what it manages; one that still reaches
 * something keeps working at the narrower reach.
 *
 * Known window: a refresh that read the grant before an owner edit and
 * inserts its session after the re-cut listed the sessions mints one at the
 * old reach, until its next refresh or its expiry (`oauth:accessTokenTTL`).
 */

import cache from 'cache';
import timestamp from 'unix-timestamp';
import { fromCallback } from 'utils';
import { pubsub, USERNAME_BASED_ACCESSES_CHANGED } from 'messages';
import { getStorageLayer } from 'storage';
import AccessLogic from 'business/src/accesses/AccessLogic.ts';
import { mergeStreamPermissions, INHERITED_RESTRICTION_FEATURES } from 'business/src/accesses/permissionSet.ts';
import { parseAccessRef, managingAccessBase } from 'business/src/accesses/refs.ts';
import { deleteAccessChain, notifyScopedAccessChange } from './accessDeletion.ts';
import { withSessionSelfRevoke, samePermissionKeys } from '../../routes/oauth2/types.ts';
import { reindexAccessNonFatal } from 'platform/src/accessIndex.ts';
import { canonicalStreamId } from 'mall/src/helpers/storeDataUtils.ts';

type PermissionEntry = Record<string, unknown>;
type SessionUser = { id: string; username: string };
type AccessRow = {
  id: string;
  type?: string;
  token?: string;
  createdBy?: string;
  expires?: number | null;
  permissions?: PermissionEntry[];
  clientData?: { oauth?: { dataGrantId?: unknown; chain?: unknown } } | null;
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

/**
 * What an access a session of `grant` created may still use under the grant
 * as it now stands: its own permissions met with the grant's, stream by
 * stream, where the grant's level on a stream the child names is the level
 * the grant reaches it with through the stream tree (a child may name a
 * stream below one the grant lists), then completed with the grant's
 * narrower entries below the streams it keeps (the tree pass of
 * `effectiveSessionPermissions`). Features: the restrictions a creator hands
 * down (`INHERITED_RESTRICTION_FEATURES`) reach the child when the grant
 * forbids them; its other feature entries are its own and kept. Never wider
 * than the child: a grant widened since leaves it as it is.
 */
export async function effectiveChildPermissions (
  userId: string, grant: { permissions?: PermissionEntry[] } & Record<string, unknown>, childPermissions: PermissionEntry[]
): Promise<{ permissions: PermissionEntry[]; hasReach: boolean }> {
  const grantPermissions = grant.permissions ?? [];
  const grantLogic = new AccessLogic(userId, { ...grant, permissions: grantPermissions });
  await grantLogic.loadPermissions();
  // The grant's reach at each stream the child names (its own entry, or the
  // one it reaches the stream with through the tree), as an entry the meet
  // compares; none: the child's entry is left out (a `none` mask is kept).
  const reach: PermissionEntry[] = [];
  for (const p of childPermissions) {
    if (typeof p.streamId !== 'string') continue;
    const id = canonicalStreamId(p.streamId);
    const level = await grantLogic._getStreamPermissionLevel(id);
    if (typeof level === 'string') reach.push({ streamId: id, level });
  }
  // Features: each the child holds is met with itself (kept as it is), plus
  // the grant's forbidden restrictions (a forbid always wins in the meet).
  const ownFeatures = childPermissions.filter((p) => typeof p.feature === 'string');
  const restrictions = grantPermissions.filter((p) => typeof p.feature === 'string' && p.setting === 'forbidden' &&
    INHERITED_RESTRICTION_FEATURES.includes(p.feature as string));
  const against = reach.concat(ownFeatures, restrictions);
  const effective = mergeStreamPermissions(childPermissions, against, 'meet').permissions as unknown as PermissionEntry[];
  const hasReach = effective.some((p) => typeof p.streamId === 'string' && p.level !== 'none');
  if (!hasReach) return { permissions: effective, hasReach };
  await new AccessLogic(userId, grant).inheritCarveOuts({ permissions: effective as never });
  return { permissions: effective, hasReach };
}

/**
 * The live accesses the sessions of the grant `grantBaseId` created, out of
 * `all`: stamped with the grant, or (created before the stamp existed) naming
 * a session of the grant, expired or not, as creator. Sessions themselves
 * excluded.
 */
function childrenOfGrant (all: AccessRow[], grantBaseId: string, now: number): AccessRow[] {
  const sessionIds = new Set(all.filter((a) => a?.type === 'app' && a.clientData?.oauth?.dataGrantId === grantBaseId).map((a) => a.id));
  return all.filter((a) => {
    if (a == null || a.type === 'app' || a.type === 'personal' || sessionIds.has(a.id)) return false;
    if (a.expires != null && now > a.expires) return false;
    const stamp = a.clientData?.oauth?.dataGrantId;
    if (stamp != null) return stamp === grantBaseId;
    if (typeof a.createdBy !== 'string' || a.createdBy === 'system') return false;
    try {
      return sessionIds.has(managingAccessBase(a.createdBy));
    } catch {
      return false;
    }
  });
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
    // The row's own permissions carry the session's selfRevoke override.
    const current = (session.permissions ?? []).filter((p) => p?.feature !== 'selfRevoke');
    // The chain's consent; a row minted before it was recorded falls back to
    // the row (it expires within the access TTL; its next refresh records it).
    const recorded = session.clientData?.oauth?.chain;
    const chain = Array.isArray(recorded) ? recorded as PermissionEntry[] : current;
    const eff = await effectiveSessionPermissions(user.id, grant as AccessRow & Record<string, unknown>, chain);
    if (!eff.hasReach) {
      await deleteAccessChain(user, { id: session.id });
      deleted++;
      continue;
    }
    if (samePermissionKeys(current, eff.permissions.filter((p) => p.feature !== 'selfRevoke'))) continue;
    const permissions = withSessionSelfRevoke(eff.permissions);
    const modified = timestamp.now();
    await fromCallback((cb: NodeCallback) =>
      accessesRepository.updateOne(user, { id: session.id }, { permissions, modified }, cb));
    if (typeof session.token === 'string') cache.unsetAccessLogic(user.id, { id: session.id, token: session.token });
    notifyScopedAccessChange(user.username, { id: session.id, type: 'app', permissions: permissions as Array<{ streamId?: string }> }, 'update');
    await reindexAccessNonFatal(user.username, { id: session.id, type: session.type, expires: session.expires, modified });
    updated++;
  }
  // Then what the sessions created (listed again: a session deleted above
  // took its own with it).
  const remaining = await fromCallback((cb: NodeCallback) => accessesRepository.find(user, {}, dbFindOptions, cb)) as AccessRow[];
  for (const child of childrenOfGrant(remaining ?? [], base, timestamp.now())) {
    const current = child.permissions ?? [];
    const eff = await effectiveChildPermissions(user.id, grant as AccessRow & Record<string, unknown>, current);
    if (!eff.hasReach) {
      await deleteAccessChain(user, { id: child.id });
      deleted++;
      continue;
    }
    if (samePermissionKeys(current, eff.permissions)) continue;
    const modified = timestamp.now();
    await fromCallback((cb: NodeCallback) =>
      accessesRepository.updateOne(user, { id: child.id }, { permissions: eff.permissions, modified }, cb));
    if (typeof child.token === 'string') cache.unsetAccessLogic(user.id, { id: child.id, token: child.token });
    notifyScopedAccessChange(user.username, { id: child.id, type: child.type, permissions: eff.permissions as Array<{ streamId?: string }> }, 'update');
    await reindexAccessNonFatal(user.username, { id: child.id, type: child.type, expires: child.expires, modified });
    updated++;
  }
  if (updated > 0) pubsub.notifications.emit(user.username, USERNAME_BASED_ACCESSES_CHANGED);
  return { updated, deleted };
}
