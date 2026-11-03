/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import * as cmc from 'cmc';
import cache from 'cache';
import { ApiEndpoint } from 'utils';
import { getMall } from 'mall';
import { getStorageLayer } from 'storage';
import { getUsersRepository } from 'business/src/users/index.ts';
import { getErasuresLocal } from 'business/src/auth/erasures.ts';
import { getLogger } from '@pryv/boiler';
import { deleteAccessChain } from './accessDeletion.ts';
import { reconcileSessionsOfGrant } from './oauthSessionReconcile.ts';

import type { MallLike } from 'cmc/src/_types.ts';

/**
 * A mall-with-accesses for the CMC modules' deps.
 *
 * The Mall exposes `streams` + `events` but NOT `accesses` (accesses live in a
 * separate storage), while the CMC handlers were written against a
 * `mall.accesses.{create,get,update,delete}` shape. The adapter bridges the two
 * AND invalidates the token-auth access-logic cache after every
 * accesses.update/delete (which is precisely why the CMC handlers never bust
 * caches themselves).
 *
 * Every CMC wiring site MUST use this composed mall, not the raw Mall: passing
 * the raw Mall gives the handlers a `mall` with no `accesses`, so anything that
 * reaches for `mall.accesses` (e.g. the responses-stream hook refusing a
 * same-subject re-accept of an open-link invite) silently becomes a no-op.
 *
 * The underlying mall / storage-layer / users-repository / cache are all
 * process-global singletons, so the composed mall is built once and shared
 * across the method modules that need it.
 */
let cached: MallLike | null = null;

/**
 * Drop an access written by the CMC / delegation adapter from the access
 * cache of this worker and of its siblings. The cross-worker unset message is
 * keyed by token: when neither this worker's cache nor the storage read
 * around the write gave the token, the user's whole access cache is dropped
 * (that bust is keyed by user id), so no sibling keeps the old access.
 */
function invalidateCmcAccessCache (userId: string, accessId: string, accessToken?: string): void {
  const cachedLogic = cache.getAccessLogicForId(userId, accessId);
  if (cachedLogic != null) {
    cache.unsetAccessLogic(userId, cachedLogic);
    return;
  }
  if (accessToken != null) {
    cache.unsetAccessLogic(userId, { id: accessId, token: accessToken });
    return;
  }
  cache.unsetUserData(userId);
}

async function buildMallForCmc (): Promise<MallLike> {
  if (cached != null) return cached;
  const mall = await getMall();
  const storageLayer = await getStorageLayer();
  const usersRepository = await getUsersRepository();

  const cmcMallAccessesAdapter = cmc.createMallAccessesAdapter({
    storageAccesses: storageLayer.accesses,
    apiEndpointBuild: ApiEndpoint.build.bind(ApiEndpoint),
    resolveUsername: async (userId: string) => {
      const u = await usersRepository.getUserById(userId);
      return u?.username;
    },
    invalidateAccessCache: invalidateCmcAccessCache,
    logger: getLogger('cmc:mall-accesses-adapter'),
    // Every plugin delete is the route's deletion (soft delete with its
    // record, webhook cascade, alias release, breach-scope tombstone,
    // cache bust on every worker, final pass), never a bare row removal.
    deleteAccess: async (userId: string, accessId: string) => {
      const u = await usersRepository.getUserById(userId);
      if (u?.username == null) throw new Error('cmc-mall-accesses-adapter: cannot resolve username for userId=' + userId);
      const outcome = await deleteAccessChain({ id: userId, username: u.username }, { id: accessId });
      return { id: accessId, relatedDeletions: outcome.relatedDeletions };
    },
  });

  // A CMC data-grant narrowed by the plugin (a consent scope update) re-cuts
  // its live OAuth sessions at once, as `accesses.update` does for the
  // owner's own edits. Non-fatal: the update stands; a session not re-cut
  // here is at its next refresh.
  type AdapterUpdate = (userId: string, params: { id: string; update: Record<string, unknown> }) => Promise<unknown>;
  const updatable = cmcMallAccessesAdapter as unknown as { update: AdapterUpdate };
  const adapterUpdate = updatable.update.bind(updatable);
  updatable.update = async (userId, params) => {
    const updated = await adapterUpdate(userId, params);
    if (Array.isArray(params?.update?.permissions)) {
      try {
        const u = await usersRepository.getUserById(userId);
        if (u?.username != null) await reconcileSessionsOfGrant({ id: userId, username: u.username }, params.id);
      } catch (err: unknown) {
        getLogger('cmc:mall-accesses-adapter').warn(`OAuth sessions of access ${params.id} not re-cut after its update: ${(err as Error)?.message ?? err}`);
      }
    }
    return updated;
  };

  // Mall uses class-instance getters for streams/events, so a plain
  // Object.assign would drop them — forward them via getters instead.
  const composed: MallLike = {
    get streams () { return mall.streams; },
    get events () { return mall.events; },
    accesses: cmcMallAccessesAdapter,
  };
  cached = composed;
  return composed;
}

/**
 * Whether the CMC background work may write for the account: 'active' while
 * the users index names it and the core holds no erasure record for it,
 * 'gone' once the index entry is removed, 'erasing' when the index still names
 * it but an erasure has started (during the erasure's steps, or for good when
 * an erasure stopped half way). The erasure writes its record before its
 * first step and removes the index entry before any data, so a write this
 * check allows lands either before the erasure's data removal (and is removed
 * with the rest) or, at worst, when the whole erasure ran between this check
 * and the write.
 */
async function cmcAccountStatus (userId: string): Promise<'active' | 'gone' | 'erasing'> {
  const usersRepository = await getUsersRepository();
  const [username, erasure] = await Promise.all([
    usersRepository.getUsernameForUserId(userId),
    (async () => (await getErasuresLocal()).get(userId))(),
  ]);
  if (username == null) return 'gone';
  return erasure == null ? 'active' : 'erasing';
}

/**
 * The accounts the CMC retry loop and member ledger pass visit: every account
 * of the core but those with an erasure record. An account whose erasure
 * stopped half way would otherwise have its queued deliveries re-sent on
 * every tick, their bookkeeping writes being refused (see the guard below).
 * One read of the erasures per tick.
 */
async function cmcLoopUserIds (): Promise<string[]> {
  const usersRepository = await getUsersRepository();
  const [users, erasures] = await Promise.all([
    usersRepository.getAllUsersIdAndName(),
    (async () => (await getErasuresLocal()).listAll())(),
  ]);
  const erasing = new Set(erasures.map((r: { userId: string }) => r.userId));
  return users.map((u: { id: string }) => u.id).filter((id: string) => !erasing.has(id));
}

/**
 * `mall` for the CMC work that runs outside the request that started it
 * (dispatch, retry loop, member sweep, accesses post-hooks, delegation detach
 * notice, stream-delete narrowing): its creates and updates are dropped for
 * an account that is gone or being erased (see cmc's accountWriteGuard.ts).
 * Request-time hooks keep the plain mall: they run for an account the request
 * just authenticated.
 */
function guardCmcBackgroundWrites<M extends object> (mall: M): M {
  return cmc.guardAccountWrites(mall, { accountStatus: cmcAccountStatus, logger: getLogger('cmc:account-guard') });
}

let cachedBackground: Promise<MallLike> | null = null;

/** The composed mall of `buildMallForCmc`, guarded for background work. */
function buildBackgroundMallForCmc (): Promise<MallLike> {
  if (cachedBackground == null) {
    cachedBackground = buildMallForCmc().then((m) => guardCmcBackgroundWrites(m));
    cachedBackground.catch(() => { cachedBackground = null; });
  }
  return cachedBackground;
}

export { buildMallForCmc, buildBackgroundMallForCmc, guardCmcBackgroundWrites, cmcAccountStatus, cmcLoopUserIds, invalidateCmcAccessCache };
