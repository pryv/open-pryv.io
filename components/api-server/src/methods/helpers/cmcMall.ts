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
 * reaches for `mall.accesses` (e.g. the accesses.delete post-hook clearing a
 * withdrawn subject from an open-link capability's `acceptedBy`) silently
 * becomes a no-op.
 *
 * The underlying mall / storage-layer / users-repository / cache are all
 * process-global singletons, so the composed mall is built once and shared
 * across the method modules that need it.
 */
let cached: MallLike | null = null;

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
    invalidateAccessCache: (userId: string, accessId: string, accessToken?: string) => {
      const cachedLogic = cache.getAccessLogicForId(userId, accessId);
      if (cachedLogic != null) {
        cache.unsetAccessLogic(userId, cachedLogic);
        return;
      }
      // Not cached on THIS worker — still broadcast the unset so sibling
      // workers holding the entry drop it (cross-worker stale-read race).
      if (accessToken != null) {
        cache.unsetAccessLogic(userId, { id: accessId, token: accessToken });
      }
    },
    logger: getLogger('cmc:mall-accesses-adapter'),
  });

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

export { buildMallForCmc };
