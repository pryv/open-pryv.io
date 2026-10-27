/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, CmcAccessLike as AccessRow } from './_types.ts';

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

const require = createRequire(import.meta.url);
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
  /**
   * The route's own deletion (api-server helpers/accessDeletion.ts): a soft
   * delete with its deletion record, the webhook cascade, the alias release,
   * the breach-scope tombstone, the cache bust on every worker and the
   * cascade to the accesses the deleted one manages. When wired, `delete`
   * goes through it and the fallback below (a bare row removal with its own
   * cascade, for unit fakes) is not used.
   */
  deleteAccess?: (userId: string, accessId: string) => Promise<{ id: string; relatedDeletions: Array<{ id: string }> }>;
};

const { fromCallback } = require('utils');
const { managedAccessesOf } = require('business/src/accesses/refs.ts');

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
     * Read one access by id (same projection and `apiEndpoint` stamping as
     * `get`). Null when there is no such access.
     */
    async getOne (userId: string, params: { id: string }): Promise<AccessRow | null> {
      if (storageAccesses.findOne == null) {
        throw new Error('cmc-mall-accesses-adapter: storageAccesses.findOne not available');
      }
      const access = await fromCallback((cb: Cb<AccessRow | null>) =>
        storageAccesses.findOne!({ id: userId }, { id: params.id }, { projection: { calls: 0, deleted: 0 } }, cb)) as AccessRow | null;
      if (access == null) return null;
      const username = await Promise.resolve(resolveUsername(userId));
      if (username == null || access.token == null) return access;
      return { ...access, apiEndpoint: apiEndpointBuild(username, access.token) };
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
      // token for cross-worker cache invalidation below). A failed re-read
      // is reported to the caller only after the invalidation: the write
      // has committed.
      let after: AccessRow | null = null;
      let reReadError: unknown = null;
      if (storageAccesses.findOne != null) {
        try {
          after = await fromCallback((cb: Cb<AccessRow | null>) =>
            storageAccesses.findOne!({ id: userId }, { id: params.id }, { projection: { calls: 0, deleted: 0 } }, cb)) as AccessRow | null;
        } catch (err: unknown) {
          reReadError = err;
        }
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
      if (reReadError != null) throw reReadError;
      if (after != null) return after;
      return { id: params.id, ...update } as AccessRow;
    },

    /**
     * Delete an access. Storage layer removes the row + access cache
     * is invalidated so a subsequent token-auth resolution doesn't
     * resurrect the access from cache.
     *
     * Deleting a non-personal access (a data grant minted as `app`, which
     * the requester may have used to create `shared` sub-accesses) takes
     * the accesses it manages with it, as the `accesses.delete` route does:
     * a consent withdrawn through any CMC path must leave no credential
     * derived from the grant behind. The managed accesses are removed
     * FIRST, so a failure part-way leaves the grant in place for a retry
     * rather than live sub-accesses whose grant is gone; once the grant is
     * gone from storage and from every worker's cache, a second pass removes
     * what was created through it in the meantime. Each removal invalidates
     * the access cache with the token, like the parent's. The ids removed
     * this way are returned as `relatedDeletions`.
     *
     * A row that cannot be read is not deleted: without its type the
     * cascade cannot be decided, and a grant removed alone is exactly what
     * this cascade exists to prevent. The caller's retry path applies.
     *
     * In production `deps.deleteAccess` is the route's own deletion (see
     * AdapterDeps): the access and its managed ones are soft-deleted with
     * their deletion records (they appear under `includeDeletions`), their
     * webhooks deleted, aliases released, the breach-scope index tombstoned.
     * The code below is the fallback for a wiring without it (unit fakes): a
     * bare row removal with the same cascade.
     */
    async delete (userId: string, params: { id: string }): Promise<{ id: string; relatedDeletions: Array<{ id: string }> }> {
      if (deps.deleteAccess != null) {
        return await deps.deleteAccess(userId, params.id);
      }
      if (storageAccesses.removeOne == null) {
        throw new Error('cmc-mall-accesses-adapter: storageAccesses.removeOne not available');
      }
      // Read the row BEFORE removal: its token lets the cache invalidation
      // be broadcast cross-worker (a sibling worker serving a deleted access
      // from cache is the security-relevant variant of the stale read), and
      // its type says whether the accesses it created go with it.
      let row: AccessRow | null = null;
      if (storageAccesses.findOne != null) {
        row = await fromCallback((cb: Cb<AccessRow | null>) =>
          storageAccesses.findOne!({ id: userId }, { id: params.id }, { projection: { calls: 0, deleted: 0 } }, cb)) as AccessRow | null;
      }
      const cascades = row != null && row.type !== 'personal' && storageAccesses.find != null;
      const removed: AccessRow[] = [];
      if (cascades) await removeManaged();
      await fromCallback((cb: Cb<unknown>) =>
        storageAccesses.removeOne!({ id: userId }, { id: params.id }, cb));
      await invalidate(params.id, row?.token ?? undefined);
      // Created through the grant between the pass above and its removal:
      // nothing can be minted through it any more, so this pass is final.
      if (cascades) await removeManaged();
      if (removed.length > 0) {
        deps.logger?.info?.('cmc/mall-accesses-adapter: deleted the accesses managed by the deleted access', {
          userId, accessId: params.id, relatedAccessIds: removed.map((a) => a.id),
        });
      }
      return { id: params.id, relatedDeletions: removed.map((a) => ({ id: a.id })) };

      async function removeManaged (): Promise<void> {
        const all = await fromCallback((cb: Cb<AccessRow[]>) =>
          storageAccesses.find!({ id: userId }, {}, { projection: { calls: 0, deleted: 0 } }, cb)) as AccessRow[];
        for (const child of managedAccessesOf(all ?? [], params.id, Date.now() / 1000)) {
          await fromCallback((cb: Cb<unknown>) =>
            storageAccesses.removeOne!({ id: userId }, { id: child.id }, cb));
          await invalidate(child.id, child.token ?? undefined);
          removed.push(child);
        }
      }

      async function invalidate (accessId: string, accessToken: string | undefined): Promise<void> {
        try {
          await deps.invalidateAccessCache?.(userId, accessId, accessToken);
        } catch (err: unknown) {
          deps.logger?.warn?.('cmc/mall-accesses-adapter: cache invalidation failed (delete)', {
            userId, accessId, error: String((err as Error)?.message || err),
          });
        }
      }
    },
  };
}

export {
  createMallAccessesAdapter,
};
