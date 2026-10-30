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

export { buildMallForCmc, invalidateCmcAccessCache };
