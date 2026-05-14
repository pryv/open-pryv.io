/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
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
 * the Plan 66 chain rules / composite-id semantics that the full
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

type StorageLayerAccesses = {
  insertOne: (user: any, accessData: any, cb: any, opts?: any) => void;
  findOne?: (user: any, query: any, opts: any, cb: any) => void;
  find?: (user: any, query: any, opts: any, cb: any) => void;
  updateOne?: (user: any, query: any, update: any, cb: any) => void;
  removeOne?: (user: any, query: any, cb: any) => void;
};

type ApiEndpointBuilder = (username: string, token: string) => string;

type AdapterDeps = {
  storageAccesses: StorageLayerAccesses;
  apiEndpointBuild: ApiEndpointBuilder;
  resolveUsername: (userId: string) => Promise<string | undefined> | string | undefined;
  tokenGen?: () => string;
  logger?: { debug: Function; warn: Function };
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
    async create (userId: string, params: any): Promise<any> {
      const username = await Promise.resolve(resolveUsername(userId));
      if (username == null) {
        throw new Error('cmc-mall-accesses-adapter: cannot resolve username for userId=' + userId);
      }
      const now = Date.now() / 1000;
      const accessData: any = {
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
      const inserted: any = await fromCallback((cb: any) =>
        storageAccesses.insertOne({ id: userId }, accessData, cb));
      const result: any = { ...inserted };
      result.apiEndpoint = apiEndpointBuild(username, result.token);
      return result;
    },

    /**
     * List accesses for a user. Optional `query` for filtering — currently
     * accepts no filters and returns all accesses (CMC code filters
     * client-side on clientData.cmc.role).
     */
    async get (userId: string, _query?: any): Promise<any[]> {
      if (storageAccesses.find == null) {
        throw new Error('cmc-mall-accesses-adapter: storageAccesses.find not available');
      }
      const accesses: any[] = await fromCallback((cb: any) =>
        storageAccesses.find!({ id: userId }, {}, { projection: { calls: 0, deleted: 0 } }, cb));
      return accesses;
    },

    /**
     * Update an access. Minimal shape: { id, update: { permissions?,
     * clientData?, name?, expires? } }. Does NOT enforce Plan 66 chain
     * rules — CMC handlers requiring chain validation should call
     * through the api-server's own accesses.update.
     */
    async update (userId: string, params: any): Promise<any> {
      if (storageAccesses.updateOne == null) {
        throw new Error('cmc-mall-accesses-adapter: storageAccesses.updateOne not available');
      }
      const username = await Promise.resolve(resolveUsername(userId));
      const update: any = { ...params.update, modified: Date.now() / 1000 };
      await fromCallback((cb: any) =>
        storageAccesses.updateOne!({ id: userId }, { id: params.id }, update, cb));
      // Re-read the updated access for the caller. Best-effort.
      if (storageAccesses.findOne != null) {
        const after: any = await fromCallback((cb: any) =>
          storageAccesses.findOne!({ id: userId }, { id: params.id }, { projection: { calls: 0, deleted: 0 } }, cb));
        if (after != null && username != null && after.token != null) {
          after.apiEndpoint = apiEndpointBuild(username, after.token);
        }
        return after;
      }
      return { id: params.id, ...update };
    },

    /**
     * Delete an access. Storage layer removes the row.
     */
    async delete (userId: string, params: any): Promise<any> {
      if (storageAccesses.removeOne == null) {
        throw new Error('cmc-mall-accesses-adapter: storageAccesses.removeOne not available');
      }
      await fromCallback((cb: any) =>
        storageAccesses.removeOne!({ id: userId }, { id: params.id }, cb));
      return { id: params.id };
    },
  };
}

export {
  createMallAccessesAdapter,
};
