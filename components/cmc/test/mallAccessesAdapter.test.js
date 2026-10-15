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

  it('[MAA01] update passes the access token to the invalidation callback', async () => {
    const after = await adapter.update('user-1', { id: 'acc-1', update: { permissions: [{ streamId: 'a', level: 'read' }] } });
    assert.equal(after.id, 'acc-1');
    assert.deepEqual(invalidations, [{ userId: 'user-1', accessId: 'acc-1', accessToken: 'tok-1' }]);
  });

  it('[MAA02] delete captures the token BEFORE removal and passes it along', async () => {
    await adapter.delete('user-1', { id: 'acc-1' });
    assert.equal(rows['acc-1'], undefined, 'row removed');
    assert.deepEqual(invalidations, [{ userId: 'user-1', accessId: 'acc-1', accessToken: 'tok-1' }]);
  });

  it('[MAA03] invalidation still fires (id-only) when the row cannot be re-read', async () => {
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

  it('[MAA05] a failing re-read after a committed update still invalidates, then reports the error', async () => {
    const storage = fakeStorageAccesses(rows);
    storage.findOne = (userOrId, query, options, cb) => cb(new Error('re-read failed'));
    adapter = createMallAccessesAdapter({
      storageAccesses: storage,
      apiEndpointBuild: (username, token) => `https://${token}@${username}.test/`,
      resolveUsername: async () => 'u1',
      invalidateAccessCache: (userId, accessId, accessToken) => {
        invalidations.push({ userId, accessId, accessToken });
      }
    });
    await assert.rejects(adapter.update('user-1', { id: 'acc-1', update: { name: 'x' } }), /re-read failed/);
    assert.equal(rows['acc-1'].name, 'x', 'the write committed');
    assert.deepEqual(invalidations, [{ userId: 'user-1', accessId: 'acc-1', accessToken: undefined }]);
  });

  it('[MAA04] getOne reads one access by id with its apiEndpoint, null when absent', async () => {
    const one = await adapter.getOne('user-1', { id: 'acc-1' });
    assert.equal(one.id, 'acc-1');
    assert.equal(one.apiEndpoint, 'https://tok-1@u1.test/');
    assert.equal(await adapter.getOne('user-1', { id: 'no-such' }), null);
  });
});

/**
 * [MAAC] mall-accesses adapter — deleting a non-personal access takes the
 * accesses it manages with it.
 *
 * A consent grant minted as `app` lets the requester create `shared`
 * sub-accesses from it. A revoke through the consent helpers deletes the
 * grant through this adapter, so the sub-accesses must go the same way the
 * `accesses.delete` route takes them: not expired, `createdBy` naming the
 * grant (bare or with a caller id), each one's cache invalidated with its
 * token, and removed BEFORE the grant.
 */
describe('[MAAC] cmc mall-accesses adapter delete cascade', () => {
  const now = Date.now() / 1000;
  let rows, invalidations, removed, adapter;
  beforeEach(() => {
    rows = {
      grant: { id: 'grant', type: 'app', token: 'tok-grant', createdBy: 'pat', permissions: [] },
      pat: { id: 'pat', type: 'personal', token: 'tok-pat', permissions: [] },
      'child-a': { id: 'child-a', type: 'shared', token: 'tok-a', createdBy: 'grant', permissions: [] },
      'child-b': { id: 'child-b', type: 'shared', token: 'tok-b', createdBy: 'grant caller-7', permissions: [] },
      'child-x': { id: 'child-x', type: 'shared', token: 'tok-x', createdBy: 'grant', expires: now - 60, permissions: [] },
      other: { id: 'other', type: 'shared', token: 'tok-o', createdBy: 'another-app', permissions: [] },
      'of-pat': { id: 'of-pat', type: 'app', token: 'tok-p', createdBy: 'pat', permissions: [] },
    };
    invalidations = [];
    removed = [];
    const storage = fakeStorageAccesses(rows);
    storage.removeOne = (userOrId, query, cb) => { removed.push(query.id); delete rows[query.id]; cb(null); };
    adapter = createMallAccessesAdapter({
      storageAccesses: storage,
      apiEndpointBuild: (username, token) => `https://${token}@${username}.test/`,
      resolveUsername: async () => 'u1',
      invalidateAccessCache: (userId, accessId, accessToken) => {
        invalidations.push({ userId, accessId, accessToken });
      }
    });
  });

  it('[MAA10] deleting an app access removes the live accesses it manages, with or without a caller id, before itself', async () => {
    const res = await adapter.delete('user-1', { id: 'grant' });
    assert.deepEqual(removed, ['child-a', 'child-b', 'grant']);
    assert.equal(rows['child-a'], undefined);
    assert.equal(rows['child-b'], undefined);
    assert.equal(rows.grant, undefined);
    assert.deepEqual(res, { id: 'grant', relatedDeletions: [{ id: 'child-a' }, { id: 'child-b' }] });
  });

  it('[MAA11] an expired managed access and the accesses of other creators are left alone', async () => {
    await adapter.delete('user-1', { id: 'grant' });
    assert.ok(rows['child-x'] != null, 'the expired one stays (it opens nothing)');
    assert.ok(rows.other != null, 'another creator\'s access stays');
    assert.ok(rows['of-pat'] != null && rows.pat != null);
  });

  it('[MAA12] every removed access is invalidated with its own token', async () => {
    await adapter.delete('user-1', { id: 'grant' });
    assert.deepEqual(invalidations, [
      { userId: 'user-1', accessId: 'child-a', accessToken: 'tok-a' },
      { userId: 'user-1', accessId: 'child-b', accessToken: 'tok-b' },
      { userId: 'user-1', accessId: 'grant', accessToken: 'tok-grant' },
    ]);
  });

  it('[MAA17] with the route deletion wired, delete goes through it and removes no row itself', async () => {
    const calls = [];
    const storage = fakeStorageAccesses(rows);
    storage.removeOne = (userOrId, query, cb) => { removed.push(query.id); cb(null); };
    const wired = createMallAccessesAdapter({
      storageAccesses: storage,
      apiEndpointBuild: (username, token) => `https://${token}@${username}.test/`,
      resolveUsername: async () => 'u1',
      deleteAccess: async (userId, accessId) => { calls.push({ userId, accessId }); return { id: accessId, relatedDeletions: [{ id: 'child-a' }] }; },
    });
    const res = await wired.delete('user-1', { id: 'grant' });
    assert.deepEqual(calls, [{ userId: 'user-1', accessId: 'grant' }]);
    assert.deepEqual(res, { id: 'grant', relatedDeletions: [{ id: 'child-a' }] });
    assert.deepEqual(removed, [], 'the storage row is the route deletion\'s business');
  });

  it('[MAA13] deleting a personal access cascades to nothing', async () => {
    const res = await adapter.delete('user-1', { id: 'pat' });
    assert.deepEqual(removed, ['pat']);
    assert.ok(rows.grant != null && rows['of-pat'] != null, 'what the personal access created stays');
    assert.deepEqual(res, { id: 'pat', relatedDeletions: [] });
  });

  it('[MA14] a failure removing a managed access leaves the managing access in place for a retry', async () => {
    const storage = fakeStorageAccesses(rows);
    storage.removeOne = (userOrId, query, cb) => {
      if (query.id === 'child-b') return cb(new Error('storage down'));
      removed.push(query.id); delete rows[query.id]; cb(null);
    };
    adapter = createMallAccessesAdapter({
      storageAccesses: storage,
      apiEndpointBuild: (username, token) => `https://${token}@${username}.test/`,
      resolveUsername: async () => 'u1',
      invalidateAccessCache: (userId, accessId, accessToken) => {
        invalidations.push({ userId, accessId, accessToken });
      }
    });
    await assert.rejects(adapter.delete('user-1', { id: 'grant' }), /storage down/);
    assert.ok(rows.grant != null, 'the grant survives, so the next revoke attempt completes the cascade');
    assert.deepEqual(removed, ['child-a']);
    assert.deepEqual(invalidations, [{ userId: 'user-1', accessId: 'child-a', accessToken: 'tok-a' }]);
  });

  it('[MAA15] a row that cannot be read is not deleted: the call rejects and nothing is removed', async () => {
    const storage = fakeStorageAccesses(rows);
    storage.findOne = (userOrId, query, options, cb) => cb(new Error('read failed'));
    storage.removeOne = (userOrId, query, cb) => { removed.push(query.id); cb(null); };
    adapter = createMallAccessesAdapter({
      storageAccesses: storage,
      apiEndpointBuild: (username, token) => `https://${token}@${username}.test/`,
      resolveUsername: async () => 'u1',
      invalidateAccessCache: (userId, accessId, accessToken) => { invalidations.push({ userId, accessId, accessToken }); }
    });
    await assert.rejects(adapter.delete('user-1', { id: 'grant' }), /read failed/);
    assert.deepEqual(removed, []);
    assert.deepEqual(invalidations, []);
    assert.ok(rows.grant != null && rows['child-a'] != null && rows['child-b'] != null);
  });

  it('[MAA16] an access created through the grant while it was being removed is removed by the final pass', async () => {
    const storage = fakeStorageAccesses(rows);
    storage.removeOne = (userOrId, query, cb) => {
      removed.push(query.id);
      delete rows[query.id];
      // minted through the grant right before its row went: the request had
      // authenticated before the cache bust
      if (query.id === 'grant') rows.late = { id: 'late', type: 'shared', token: 'tok-late', createdBy: 'grant', permissions: [] };
      cb(null);
    };
    adapter = createMallAccessesAdapter({
      storageAccesses: storage,
      apiEndpointBuild: (username, token) => `https://${token}@${username}.test/`,
      resolveUsername: async () => 'u1',
      invalidateAccessCache: (userId, accessId, accessToken) => { invalidations.push({ userId, accessId, accessToken }); }
    });
    const res = await adapter.delete('user-1', { id: 'grant' });
    assert.deepEqual(removed, ['child-a', 'child-b', 'grant', 'late']);
    assert.equal(rows.late, undefined);
    assert.deepEqual(res.relatedDeletions, [{ id: 'child-a' }, { id: 'child-b' }, { id: 'late' }]);
    assert.deepEqual(invalidations.at(-1), { userId: 'user-1', accessId: 'late', accessToken: 'tok-late' });
  });
});
