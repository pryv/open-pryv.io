/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — `mall.accesses` adapter.
 *
 * The Mall doesn't expose `accesses` — those live in
 * `storageLayer.accesses` with a callback-style interface
 * (`insertOne(user, data, cb)`). The CMC handlers were written
 * against a clean promise-based `mall.accesses.{create, get, update,
 * delete}` shape so they could be unit-tested with simple fakes.
 *
 * This adapter wraps `storageLayer.accesses` into that shape, plus
 * builds the `apiEndpoint` on returned create results (which CMC needs
 * for outbound delivery to peers).
 *
 * Construct once in api-server boot and inject into the dispatch deps
 * + capabilityMintHook + accessesUpdateHook factories that need
 * `mall.accesses`.
 *
 * NOTE: this adapter is intentionally minimal — it does NOT enforce
 * the chain rules / composite-id semantics that the full
 * `accesses.update` method path applies. CMC handlers that need full
 * chain-rule validation should call through the api-server's own
 * `accesses.update` API method instead (via the api-method registry).
 * For now, CMC only uses this adapter for:
 *   - create: capability access (capabilityMintHook), data-grant
 *     access (handleAccept), back-channel access (handleIncomingAccept).
 *   - get: enumerate accesses to find counterparties (handleChat,
 *     handleSystem, handleRevoke).
 *   - delete: tear down access pair on revoke.
 *   - update: scope-change application (handleSystemScopeUpdate
 *     local-apply branch).
 */

import type { CmcAccessLike as AccessRow } from './_types.ts';
type AccessQuery = Record<string, unknown>;
type AccessUpdate = Record<string, unknown>;
type AccessOptions = Record<string, unknown>;
type UserRef = { id: string };
type Cb<T = unknown> = (err: Error | null, result?: T) => void;

type StorageLayerAccesses = {
  insertOne: (user: UserRef, accessData: AccessRow, cb: Cb<AccessRow>, opts?: AccessOptions) => void;
  findOne?: (user: UserRef, query: AccessQuery, opts: AccessOptions, cb: Cb<AccessRow | null>) => void;
  find?: (user: UserRef, query: AccessQuery, opts: AccessOptions, cb: Cb<AccessRow[]>) => void;
  updateOne?: (user: UserRef, query: AccessQuery, update: AccessUpdate, cb: Cb<unknown>) => void;
  removeOne?: (user: UserRef, query: AccessQuery, cb: Cb<unknown>) => void;
};

type ApiEndpointBuilder = (username: string, token: string) => string;

type AdapterDeps = {
  storageAccesses: StorageLayerAccesses;
  apiEndpointBuild: ApiEndpointBuilder;
  resolveUsername: (userId: string) => Promise<string | undefined> | string | undefined;
  tokenGen?: () => string;
  /**
   * Best-effort cache invalidation: called by update/delete after the
   * storage write succeeds. The api-server wires this to clear the
   * per-user access-logic cache (`cache.unsetAccessLogic`) so
   * subsequent token-auth resolutions on the updated access see fresh
   * permissions. `accessToken` (when available) lets the implementation
   * broadcast the invalidation to OTHER workers even if the calling
   * worker never cached the access itself — without it, a worker that
   * handled the write but not the original auth would skip the
   * cross-worker unset and siblings would serve stale permissions until
   * cache TTL. No-op when undefined (e.g. unit tests).
   */
  invalidateAccessCache?: (userId: string, accessId: string, accessToken?: string) => void | Promise<void>;
  logger?: CmcLogger;
};

const { fromCallback } = require('utils');

/**
 * Build a `mall.accesses`-shaped object backed by storageLayer.accesses.
 *
 * Returns an object with `create / get / update / delete` matching the
 * MallLike shape used throughout the CMC handlers.
 */
function createMallAccessesAdapter (deps: AdapterDeps) {
  const { storageAccesses, apiEndpointBuild, resolveUsername } = deps;
  const tokenGen = deps.tokenGen ?? (() => {
    const { createId } = require('@paralleldrive/cuid2');
    return createId();
  });

  return {
    /**
     * Create a shared access. Returns the persisted access with
     * `apiEndpoint` populated for outbound delivery.
     */
    async create (userId: string, params: Partial<AccessRow> & { name?: string; permissions?: unknown[]; clientData?: Record<string, unknown>; createdBy?: string; modifiedBy?: string; expires?: number }): Promise<AccessRow> {
      const username = await Promise.resolve(resolveUsername(userId));
      if (username == null) {
        throw new Error('cmc-mall-accesses-adapter: cannot resolve username for userId=' + userId);
      }
      const now = Date.now() / 1000;
      const accessData: AccessRow = {
        id: params.id ?? '',
        token: params.token ?? tokenGen(),
        name: params.name,
        type: params.type ?? 'shared',
        permissions: params.permissions ?? [],
        clientData: params.clientData ?? {},
        created: now,
        createdBy: params.createdBy ?? 'system',
        modified: now,
        modifiedBy: params.modifiedBy ?? 'system',
      };
      if (params.expires != null) accessData.expires = params.expires;
      const inserted = await fromCallback((cb: Cb<AccessRow>) =>
        storageAccesses.insertOne({ id: userId }, accessData, cb)) as AccessRow;
      const result: AccessRow = { ...inserted };
      result.apiEndpoint = apiEndpointBuild(username, result.token as string);
      return result;
    },

    /**
     * List accesses for a user. Optional `query` for filtering — currently
     * accepts no filters and returns all accesses (CMC code filters
     * client-side on clientData.cmc.role). Rows carry `apiEndpoint` (same
     * stamping as create) so handlers reusing an existing access — e.g.
     * an accept re-dispatch finding its own prior data-grant — have a
     * delivery target without a second storage round-trip.
     */
    async get (userId: string, _query?: AccessQuery): Promise<AccessRow[]> {
      if (storageAccesses.find == null) {
        throw new Error('cmc-mall-accesses-adapter: storageAccesses.find not available');
      }
      const accesses = await fromCallback((cb: Cb<AccessRow[]>) =>
        storageAccesses.find!({ id: userId }, {}, { projection: { calls: 0, deleted: 0 } }, cb)) as AccessRow[];
      const username = await Promise.resolve(resolveUsername(userId));
      if (username == null) return accesses;
      return accesses.map((a) => (a.token != null
        ? { ...a, apiEndpoint: apiEndpointBuild(username, a.token as string) }
        : a));
    },

    /**
     * Update an access. Minimal shape: { id, update: { permissions?,
     * clientData?, name?, expires? } }. Does NOT enforce composite-id
     * chain rules — CMC handlers requiring chain validation should
     * call through the api-server's own accesses.update.
     */
    async update (userId: string, params: { id: string; update: AccessUpdate }): Promise<AccessRow> {
      if (storageAccesses.updateOne == null) {
        throw new Error('cmc-mall-accesses-adapter: storageAccesses.updateOne not available');
      }
      const username = await Promise.resolve(resolveUsername(userId));
      const update: AccessUpdate = { ...params.update, modified: Date.now() / 1000 };
      await fromCallback((cb: Cb<unknown>) =>
        storageAccesses.updateOne!({ id: userId }, { id: params.id }, update, cb));
      // Re-read the updated access for the caller (also provides the
      // token for cross-worker cache invalidation below). Best-effort.
      let after: AccessRow | null = null;
      if (storageAccesses.findOne != null) {
        after = await fromCallback((cb: Cb<AccessRow | null>) =>
          storageAccesses.findOne!({ id: userId }, { id: params.id }, { projection: { calls: 0, deleted: 0 } }, cb)) as AccessRow | null;
        if (after != null && username != null && after.token != null) {
          after.apiEndpoint = apiEndpointBuild(username, after.token);
        }
      }
      // Cache invalidation — without this the per-user access-logic
      // cache keeps stale permissions and subsequent token-auth
      // resolutions on the updated access miss the new scope until
      // the cache TTL expires. The token lets the invalidation reach
      // OTHER workers even when this worker never cached the access.
      // Best-effort; failure logged but not fatal.
      try {
        await deps.invalidateAccessCache?.(userId, params.id, after?.token ?? undefined);
      } catch (err: unknown) {
        deps.logger?.warn?.('cmc/mall-accesses-adapter: cache invalidation failed (update)', {
          userId, accessId: params.id, error: String((err as Error)?.message || err),
        });
      }
      if (after != null) return after;
      return { id: params.id, ...update } as AccessRow;
    },

    /**
     * Delete an access. Storage layer removes the row + access cache
     * is invalidated so a subsequent token-auth resolution doesn't
     * resurrect the access from cache.
     */
    async delete (userId: string, params: { id: string }): Promise<{ id: string }> {
      if (storageAccesses.removeOne == null) {
        throw new Error('cmc-mall-accesses-adapter: storageAccesses.removeOne not available');
      }
      // Capture the token BEFORE removal so the cache invalidation can be
      // broadcast cross-worker (a sibling worker serving a deleted access
      // from cache is the security-relevant variant of the stale read).
      let token: string | undefined;
      if (storageAccesses.findOne != null) {
        try {
          const row = await fromCallback((cb: Cb<AccessRow | null>) =>
            storageAccesses.findOne!({ id: userId }, { id: params.id }, { projection: { calls: 0, deleted: 0 } }, cb)) as AccessRow | null;
          token = row?.token ?? undefined;
        } catch (err: unknown) { /* best-effort — fall back to id-only invalidation */ }
      }
      await fromCallback((cb: Cb<unknown>) =>
        storageAccesses.removeOne!({ id: userId }, { id: params.id }, cb));
      try {
        await deps.invalidateAccessCache?.(userId, params.id, token);
      } catch (err: unknown) {
        deps.logger?.warn?.('cmc/mall-accesses-adapter: cache invalidation failed (delete)', {
          userId, accessId: params.id, error: String((err as Error)?.message || err),
        });
      }
      return { id: params.id };
    },
  };
}

export {
  createMallAccessesAdapter,
};
