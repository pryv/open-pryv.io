/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [MAAD] mall-accesses adapter — cache-invalidation contract.
 *
 * The invalidation callback must receive the access TOKEN on update and
 * delete: with only the id, a worker that never cached the access cannot
 * broadcast the unset to sibling workers, which then serve stale (or
 * deleted) permissions until cache TTL — the cross-worker stale-read race.
 */

const assert = require('node:assert/strict');
const { createMallAccessesAdapter } = require('../src/mallAccessesAdapter.ts');

function fakeStorageAccesses (rows) {
  return {
    updateOne (userOrId, query, update, cb) { Object.assign(rows[query.id], update); cb(null); },
    removeOne (userOrId, query, cb) { delete rows[query.id]; cb(null); },
    findOne (userOrId, query, options, cb) { cb(null, rows[query.id] ? { ...rows[query.id] } : null); },
    find (userOrId, query, options, cb) { cb(null, Object.values(rows)); }
  };
}

describe('[MAAD] cmc mall-accesses adapter cache invalidation', () => {
  let rows, invalidations, adapter;
  beforeEach(() => {
    rows = { 'acc-1': { id: 'acc-1', token: 'tok-1', permissions: [] } };
    invalidations = [];
    adapter = createMallAccessesAdapter({
      storageAccesses: fakeStorageAccesses(rows),
      apiEndpointBuild: (username, token) => `https://${token}@${username}.test/`,
      resolveUsername: async () => 'u1',
      invalidateAccessCache: (userId, accessId, accessToken) => {
        invalidations.push({ userId, accessId, accessToken });
      }
    });
  });

  it('[MA01] update passes the access token to the invalidation callback', async () => {
    const after = await adapter.update('user-1', { id: 'acc-1', update: { permissions: [{ streamId: 'a', level: 'read' }] } });
    assert.equal(after.id, 'acc-1');
    assert.deepEqual(invalidations, [{ userId: 'user-1', accessId: 'acc-1', accessToken: 'tok-1' }]);
  });

  it('[MA02] delete captures the token BEFORE removal and passes it along', async () => {
    await adapter.delete('user-1', { id: 'acc-1' });
    assert.equal(rows['acc-1'], undefined, 'row removed');
    assert.deepEqual(invalidations, [{ userId: 'user-1', accessId: 'acc-1', accessToken: 'tok-1' }]);
  });

  it('[MA03] invalidation still fires (id-only) when the row cannot be re-read', async () => {
    // rebuild without findOne
    const storage = fakeStorageAccesses(rows);
    delete storage.findOne;
    adapter = createMallAccessesAdapter({
      storageAccesses: storage,
      apiEndpointBuild: (username, token) => `https://${token}@${username}.test/`,
      resolveUsername: async () => 'u1',
      invalidateAccessCache: (userId, accessId, accessToken) => {
        invalidations.push({ userId, accessId, accessToken });
      }
    });
    await adapter.update('user-1', { id: 'acc-1', update: { name: 'x' } });
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0].accessId, 'acc-1');
    assert.equal(invalidations[0].accessToken, undefined);
  });
});
