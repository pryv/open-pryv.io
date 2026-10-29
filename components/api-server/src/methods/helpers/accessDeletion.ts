/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import cache from 'cache';
import timestamp from 'unix-timestamp';
import { fromCallback } from 'utils';
import { pubsub, WEBHOOKS_DELETE, USERNAME_BASED_ACCESSES_CHANGED } from 'messages';
import { getStorageLayer } from 'storage';
import { getLogger } from '@pryv/boiler';
import { getUsersRepository } from 'business/src/users/index.ts';
import { managedAccessesOf, isManagedBy, parseAccessRef } from 'business/src/accesses/refs.ts';
import { withoutCredentialUrls } from 'business/src/accesses/credentialUrls.ts';
import WebhooksRepository from 'business/src/webhooks/repository.ts';
import { tombstoneAccessesNonFatal } from 'platform/src/accessIndex.ts';

/**
 * The deletion of an access and of what it manages, with every side effect
 * the `accesses.delete` route owes: the webhooks of each deleted access are
 * deleted and their running copies stopped, the rows are soft-deleted (a
 * deletion record stays, readable with `includeDeletions`), each deleted
 * token is dropped from every worker's access cache after the write, an
 * access created through the deleted one in the meantime goes in a final
 * pass, the aliases are released, the breach-scope index is tombstoned and
 * the account's socket clients are told.
 *
 * One implementation for the route and for the plugins (the CMC and
 * delegation teardowns delete through the mall accesses adapter, which calls
 * this): a consent withdrawn through any path leaves the same record as a
 * plain `accesses.delete`.
 */

type AccessRow = {
  id: string;
  type?: string;
  token?: string;
  alias?: string;
  expires?: number | null;
  created?: number;
  modified?: number;
  createdBy?: string;
  permissions?: Array<{ streamId?: string }>;
  clientData?: Record<string, unknown> | null;
};

type DeletionUser = { id: string; username: string };
type NodeCallback = (err: Error | null, result?: unknown) => void;
type IndexAccessInput = { id?: unknown; type?: unknown; expires?: unknown; created?: unknown; modified?: unknown };

const dbFindOptions = { projection: { calls: 0, deleted: 0 } };

/**
 * Scoped notification: the changed access id, type and the streams it
 * grants, so a notification engine can match standing accesses-kind scopes.
 * Additive to the coarse USERNAME_BASED_ACCESSES_CHANGED signal. (A deletion
 * carries the id only.)
 */
function notifyScopedAccessChange (username: string, access: { id?: string; type?: string; permissions?: Array<{ streamId?: string }> } | null | undefined, changeType: string): void {
  if (access?.id == null) return;
  const permissions = Array.isArray(access.permissions) ? access.permissions : [];
  const streamIds = permissions.map((p) => p?.streamId).filter((s): s is string => s != null);
  pubsub.scopedNotifications.emit(username, {
    kind: 'accesses',
    changeType,
    access: { id: access.id, type: access.type, streamIds }
  });
}

type ScrubRepository = {
  updateOne: (user: DeletionUser, query: Record<string, unknown>, update: Record<string, unknown>, cb: NodeCallback) => void;
  findHistory?: (user: DeletionUser, baseId: string) => Promise<AccessRow[]>;
};

/**
 * A consent (CMC) relationship access keeps the counterparty's endpoints in
 * `clientData.cmc`, tokens included. The deletion record outlives the access
 * (`includeDeletions`, backups, exports), and so do the history rows its
 * updates snapshotted, so once the row is marked deleted the credentials
 * leave it and its history: every URL user part in `clientData` is removed
 * (host and path kept) and the deletion row's own token is unset (a deleted
 * row never authenticates). Runs AFTER the delete, so a delete that fails
 * leaves the live access intact. One write per row that holds a credential.
 */
async function scrubCredentialUrls (accessesRepository: ScrubRepository, user: DeletionUser, access: AccessRow): Promise<void> {
  const rows: Array<{ id: string; clientData?: Record<string, unknown> | null; head: boolean }> = [{ id: access.id, clientData: access.clientData, head: true }];
  if (accessesRepository.findHistory != null) {
    try {
      const history = await accessesRepository.findHistory(user, access.id);
      for (const h of history ?? []) if (typeof h?.id === 'string') rows.push({ id: h.id, clientData: h.clientData, head: false });
    } catch (_e) { /* the head row is still scrubbed */ }
  }
  for (const row of rows) {
    if (row.clientData == null) continue;
    const scrubbed = withoutCredentialUrls(row.clientData);
    if (JSON.stringify(scrubbed) === JSON.stringify(row.clientData)) continue;
    const update: Record<string, unknown> = { clientData: scrubbed, modified: timestamp.now() };
    if (row.head) update.token = null;
    await fromCallback((cb: NodeCallback) => { accessesRepository.updateOne(user, { id: row.id }, update, cb); });
    if (row.head) access.clientData = scrubbed as AccessRow['clientData'];
  }
}

/**
 * The scrub runs after the delete: a failure leaves the credential at rest
 * (the exposure that existed before the scrub) and must not abort the rest
 * of the chain (the late pass, the alias release, the tombstones, the
 * notifications), so it is logged per access and swallowed (a failing
 * head-row update skips that access's history rows).
 */
async function scrubOrWarn (accessesRepository: ScrubRepository, user: DeletionUser, access: AccessRow): Promise<void> {
  try {
    await scrubCredentialUrls(accessesRepository, user, access);
  } catch (err: unknown) {
    getLogger('accesses:deletion').warn('the credential scrub of a deleted access failed; its deletion record keeps the peer endpoint', {
      accessId: access.id, error: String((err as Error)?.message ?? err),
    });
  }
}

/**
 * An OAuth session access names the consent data-grant it was minted under
 * (`clientData.oauth.dataGrantId`, written by the OAuth routes only). A
 * withdrawn grant takes those sessions with it, and what they created,
 * instead of leaving their tokens valid until their own expiry.
 */
function isSessionOfGrant (access: AccessRow, grantBaseId: string): boolean {
  const oauth = access?.clientData?.oauth as { dataGrantId?: unknown } | undefined;
  return access?.type === 'app' && oauth?.dataGrantId === grantBaseId;
}

function sessionsOfGrant (all: AccessRow[], grantBaseId: string, now: number, known: AccessRow[]): AccessRow[] {
  const seen = new Set<string>(known.map((a) => a.id).concat(grantBaseId));
  const live = (a: AccessRow) => !seen.has(a.id) && !(a.expires != null && now > a.expires);
  const sessions = all.filter((a) => live(a) && isSessionOfGrant(a, grantBaseId));
  for (const s of sessions) seen.add(s.id);
  const created = sessions.flatMap((s) => managedAccessesOf(all, s.id, now)).filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  return sessions.concat(created);
}

/**
 * The ids `deleteAccessChain` would delete for `id` (the access, what it
 * manages, the sessions of the grant and what they created), read only. A
 * caller whose teardown failed soft-deletes them bare, so the chain still
 * dies whole.
 */
async function accessChainIds (user: DeletionUser, id: string): Promise<string[]> {
  const storageLayer = await getStorageLayer();
  const all = await fromCallback((cb: NodeCallback) => storageLayer.accesses.find(user, {}, dbFindOptions, cb)) as AccessRow[];
  const now = timestamp.now();
  const related = managedAccessesOf(all, id, now);
  const sessions = sessionsOfGrant(all, parseAccessRef(id).base, now, related);
  return [id].concat(related.map((a) => a.id), sessions.map((a) => a.id));
}

type DeletionOutcome = {
  // False when no such live access exists (nothing was done).
  deleted: boolean;
  accessToDelete: AccessRow | null;
  // The accesses deleted with it (the final pass included).
  relatedAccessesToDelete: AccessRow[];
  relatedDeletions: Array<{ id: string }>;
};

/**
 * Delete the access `params.id` of `user` and what it manages.
 * `accessToDelete` / `relatedAccessesToDelete` are passed by the route (which
 * read them to answer and to check permissions); a plugin passes the id only.
 */
async function deleteAccessChain (user: DeletionUser, params: { id: string; accessToDelete?: AccessRow | null; relatedAccessesToDelete?: AccessRow[] | null }): Promise<DeletionOutcome> {
  const storageLayer = await getStorageLayer();
  const accessesRepository = storageLayer.accesses;
  const webhooksRepository = new WebhooksRepository(storageLayer.webhooks, storageLayer.events, storageLayer.accesses);

  let accessToDelete: AccessRow | null = params.accessToDelete ?? null;
  if (accessToDelete == null) {
    accessToDelete = await fromCallback((cb: NodeCallback) => accessesRepository.findOne(user, { id: params.id }, dbFindOptions, cb)) as AccessRow | null;
  }
  if (accessToDelete == null) {
    return { deleted: false, accessToDelete: null, relatedAccessesToDelete: [], relatedDeletions: [] };
  }
  // Deleting a personal access does NOT delete the app/shared accesses it
  // created (the user keeps the apps they granted while logged in). Only
  // app/shared deletes cascade to descendants, matched on the access id
  // inside `createdBy` (an access created under a caller id is recorded as
  // `<id> <callerId>`).
  let related: AccessRow[] = params.relatedAccessesToDelete ?? [];
  const grantBaseId = parseAccessRef(params.id).base;
  let sessionIds: string[] = [];
  if (accessToDelete.type !== 'personal') {
    const all = await fromCallback((cb: NodeCallback) => accessesRepository.find(user, {}, dbFindOptions, cb)) as AccessRow[];
    if (params.relatedAccessesToDelete == null) related = managedAccessesOf(all, params.id, timestamp.now());
    const sessions = sessionsOfGrant(all, grantBaseId, timestamp.now(), related);
    sessionIds = sessions.filter((a) => isSessionOfGrant(a, grantBaseId)).map((a) => a.id);
    related = related.concat(sessions);
  }
  let idsToDelete: Array<{ id: string }> = [{ id: params.id }].concat(related.map((a) => ({ id: a.id })));

  // Cache invalidation is deferred until AFTER the delete commits (below):
  // busting before the write let a concurrent auth re-cache the row
  // mid-delete and keep resolving a deleted token. Collect the {id, token} to
  // unset from the authoritative rows fetched in the loop below.
  const logicsToUnset: Array<{ id: string; token: string }> = [];
  // Any aliases carried by the accesses being deleted, so their platform
  // reservation + routing entries can be released afterwards. The same pass
  // captures the authoritative access rows (still live here) so the
  // breach-scope reverse-index can be tombstoned after deletion.
  const aliasesToRelease: string[] = [];
  const rowsToTombstone: IndexAccessInput[] = [];
  const rowsToScrub: AccessRow[] = [];
  for (const idToDelete of idsToDelete) {
    const access = await fromCallback((cb: NodeCallback) => accessesRepository.findOne(user, { id: idToDelete.id }, dbFindOptions, cb)) as AccessRow | null;
    if (access != null && typeof access.alias === 'string') { aliasesToRelease.push(access.alias); }
    if (access != null) { rowsToTombstone.push(access as IndexAccessInput); } else if (idToDelete.id != null) { rowsToTombstone.push({ id: idToDelete.id }); }
    if (access != null) rowsToScrub.push(access);
    if (access != null && typeof access.id === 'string' && typeof access.token === 'string') {
      logicsToUnset.push({ id: access.id, token: access.token });
    } else {
      const cached = cache.getAccessLogicForId(user.id, idToDelete.id);
      if (cached != null) { logicsToUnset.push({ id: cached.id, token: cached.token }); }
    }
  }
  // Cascade webhook deletion BEFORE access deletion. On partial failure, the
  // access still exists so a retry re-runs the cascade.
  for (const idToDelete of idsToDelete) {
    // The repository reads the webhooks OF this access (a non-personal view).
    const hooks = await webhooksRepository.get(user, { id: idToDelete.id, isPersonal: () => false, isApp: () => false });
    await webhooksRepository.deleteByAccess(user, idToDelete.id);
    // Stop the running copies (they would otherwise stay registered until a restart).
    for (const hook of hooks) {
      pubsub.webhooks.emit(WEBHOOKS_DELETE, { username: user.username, webhook: { id: hook.id } });
    }
  }
  let deleteErr: unknown = null;
  try {
    await fromCallback((cb: NodeCallback) => { accessesRepository.delete(user, { $or: idsToDelete }, cb); });
  } catch (err) {
    deleteErr = err;
  }
  // Bust the cache AFTER the delete attempt (unconditionally, including an
  // ambiguous failure where the row may have been removed): a concurrent auth
  // that re-cached the row during the delete window must not keep resolving a
  // deleted token. unsetAccessLogic bumps the epoch and broadcasts to sibling
  // workers even when nothing is cached locally.
  for (const logic of logicsToUnset) {
    cache.unsetAccessLogic(user.id, logic);
  }
  if (deleteErr != null) throw deleteErr;
  for (const row of rowsToScrub) await scrubOrWarn(accessesRepository as unknown as ScrubRepository, user, row);
  // An access created through the deleted one (or through a deleted session
  // of it, or a session a refresh minted under it) between the find above and
  // the delete (or by a request that authenticated before the cache bust)
  // would survive it unmanaged. The deleted accesses can create nothing any
  // more, so one more pass is final. Reported like the others.
  if (accessToDelete.type !== 'personal') {
    const all = await fromCallback((cb: NodeCallback) => accessesRepository.find(user, {}, dbFindOptions, cb)) as AccessRow[];
    const now = timestamp.now();
    const deletedIds = new Set(idsToDelete.map((d) => d.id));
    const late = all.filter((a) => typeof a.id === 'string' && !deletedIds.has(a.id) &&
      !(a.expires != null && now > a.expires) &&
      (isManagedBy(a, params.id) || isSessionOfGrant(a, grantBaseId) || sessionIds.some((id) => isManagedBy(a, id))));
    if (late.length > 0) {
      await fromCallback((cb: NodeCallback) => { accessesRepository.delete(user, { $or: late.map((a) => ({ id: a.id })) }, cb); });
      for (const a of late) {
        if (typeof a.id === 'string' && typeof a.token === 'string') cache.unsetAccessLogic(user.id, { id: a.id, token: a.token });
        rowsToTombstone.push(a as IndexAccessInput);
        await scrubOrWarn(accessesRepository as unknown as ScrubRepository, user, a);
      }
      related = related.concat(late);
      idsToDelete = idsToDelete.concat(late.map((a) => ({ id: a.id })));
    }
  }
  if (aliasesToRelease.length > 0) {
    const usersRepository = await getUsersRepository();
    for (const alias of aliasesToRelease) {
      await usersRepository.releaseAlias(alias, user.id);
    }
  }
  // Tombstone every deleted (base + cascaded) access in the breach-scope
  // reverse-index: the row is retained with a `deleted` timestamp so a breach
  // scoped after revocation still resolves the accessId. Non-fatal.
  await tombstoneAccessesNonFatal(user.username, rowsToTombstone, timestamp.now());
  pubsub.notifications.emit(user.username, USERNAME_BASED_ACCESSES_CHANGED);
  notifyScopedAccessChange(user.username, { id: params.id }, 'delete');
  return {
    deleted: true,
    accessToDelete,
    relatedAccessesToDelete: related,
    relatedDeletions: related.map((a) => ({ id: a.id })),
  };
}

export { deleteAccessChain, accessChainIds, notifyScopedAccessChange };
export type { DeletionOutcome, DeletionUser };
