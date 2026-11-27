/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [PLATCFG] the platform-wide configuration rows (business/src/platformConfig)
 * on a real platform engine: schema checks, compare-and-set writes and the
 * revision under concurrency, the scope load (invalid rows skipped), local
 * overrides, cores behind, the explicit seed and the periodic check. Run by
 * each engine's PlatformDB conformance suite.
 * @param {Function} getDB - async function returning an initialized PlatformDB instance
 */
export default function platformConfigConformance (getDB) {
  const assert = require('node:assert/strict');
  const pc = require('business/src/platformConfig/index.ts');

  const TEST_SCHEMA = Object.freeze({
    'service.name': { schema: { type: 'string', minLength: 1, maxLength: 80 }, appliesAt: 'live', sensitive: false, capability: 'config' },
    'service.home': { schema: { type: 'string', pattern: '^https?://' }, appliesAt: 'live', sensitive: false, capability: 'config' },
    'auth.passwordComplexityMinLength': { schema: { type: 'integer', minimum: 4, maximum: 64 }, appliesAt: 'live', sensitive: true, capability: 'config' }
  });
  const BY = Object.freeze({ kind: 'cli', coreId: 'core-a' });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A configuration with a local layer and the platform-store scope above it. */
  function fakeConfig (local = {}) {
    let store = {};
    const at = (tree, path) => path.split(':').reduce((n, s) => (n == null ? undefined : n[s]), tree);
    return {
      replaceScopeConfig (scope, obj) {
        assert.equal(scope, 'platform-store');
        store = obj;
      },
      get (path) {
        const v = at(store, path);
        return v !== undefined ? v : at(local, path);
      },
      getLocal (path) { return at(local, path); },
      storeTree: () => store
    };
  }

  describe('[PLATCFG] platform configuration rows on the platform store', function () {
    this.timeout(20000);
    let db;

    before(async () => {
      db = await getDB();
      await db.deleteAll();
      pc.setSchemaForTests(TEST_SCHEMA);
    });

    after(() => {
      pc.setSchemaForTests(null);
    });

    afterEach(async () => {
      await db.deleteAll();
    });

    it('[PLATCFG1] set, get, list: validated, the revision bumps, the writer is recorded', async () => {
      assert.equal(await pc.currentRev(db), 0);
      const first = await pc.setEntry(db, 'service.name', 'First', BY);
      assert.equal(first.before, null);
      assert.equal(first.after.value, 'First');
      assert.deepEqual(first.after.updatedBy, { kind: 'cli', coreId: 'core-a' });
      assert.equal(first.rev, 1);
      const second = await pc.setEntry(db, 'service.name', 'Second', { kind: 'session', userId: 'u1', coreId: 'core-b' });
      assert.equal(second.before.value, 'First');
      assert.equal(second.rev, 2);
      const read = await pc.getEntry(db, 'service.name');
      assert.equal(read.value, 'Second');
      assert.deepEqual(read.updatedBy, { kind: 'session', userId: 'u1', coreId: 'core-b' });
      assert.ok(read.updatedAt > 0);
      assert.deepEqual((await pc.listEntries(db)).map((e) => e.key), ['service.name']);
      assert.equal(await pc.currentRev(db), 2);
    });

    it('[PLATCFG2] a key outside the schema, or a value its schema refuses, is not written', async () => {
      await assert.rejects(pc.setEntry(db, 'service.terms', 'x', BY), pc.UnknownKeyError);
      await assert.rejects(pc.setEntry(db, 'bad_key', 'x', BY), pc.UnknownKeyError);
      await assert.rejects(pc.setEntry(db, 'service.home', 'ftp://x', BY), (err) => err instanceof pc.InvalidValueError && err.errors.length > 0);
      await assert.rejects(pc.setEntry(db, 'service.name', '', BY), pc.InvalidValueError);
      await assert.rejects(pc.setEntry(db, 'service.name', undefined, BY), pc.InvalidValueError);
      await assert.rejects(pc.setEntry(db, 'service.name', 'x', { kind: 'other', coreId: 'a' }), /updatedBy/);
      assert.deepEqual(await pc.listEntries(db), []);
      assert.equal(await pc.currentRev(db), 0);
    });

    it('[PLATCFG3] unset: the row goes, the revision bumps once; a stale row of an unknown key can be removed', async () => {
      await pc.setEntry(db, 'service.name', 'X', BY);
      const removed = await pc.unsetEntry(db, 'service.name', BY);
      assert.equal(removed.before.value, 'X');
      assert.equal(removed.rev, 2);
      assert.equal(await pc.getEntry(db, 'service.name'), null);
      const again = await pc.unsetEntry(db, 'service.name', BY);
      assert.equal(again.before, null);
      assert.equal(again.rev, 2, 'nothing to delete: no bump');
      await assert.rejects(pc.unsetEntry(db, 'service.terms', BY), pc.UnknownKeyError);
      await db.setPlatformKv('platform-config/service.terms', JSON.stringify({ value: 'old', updatedAt: 1, updatedBy: BY }));
      assert.equal((await pc.unsetEntry(db, 'service.terms', BY)).before.value, 'old');
      assert.equal(await db.getPlatformKv('platform-config/service.terms'), null);
    });

    it('[PLATCFG4] concurrent writes: every write lands and bumps the revision once', async () => {
      const writes = [];
      for (let i = 0; i < 4; i++) {
        writes.push(pc.setEntry(db, 'service.name', 'n' + i, BY));
        writes.push(pc.setEntry(db, 'service.home', 'https://h' + i + '.example', BY));
      }
      const results = await Promise.all(writes);
      assert.equal(await pc.currentRev(db), 8);
      assert.deepEqual(results.map((r) => r.rev).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.deepEqual((await pc.listEntries(db)).map((e) => e.key), ['service.home', 'service.name']);
    });

    it('[PLATCFG5] loadScope: valid rows fill the scope, unknown, refused and malformed rows are skipped, the core revision is recorded', async () => {
      await pc.setEntry(db, 'service.name', 'Stored', BY);
      await pc.setEntry(db, 'auth.passwordComplexityMinLength', 12, BY);
      await db.setPlatformKv('platform-config/service.home', JSON.stringify({ value: 'ftp://refused', updatedAt: 1, updatedBy: BY }));
      await db.setPlatformKv('platform-config/service.unknown', JSON.stringify({ value: 'x', updatedAt: 1, updatedBy: BY }));
      await db.setPlatformKv('platform-config/service.malformed', '{not json');
      const config = fakeConfig({ service: { name: 'Local', home: 'https://local.example' } });
      const state = await pc.loadScope(config, db, 'core-a');
      assert.equal(state.rev, 2);
      assert.deepEqual(state.keys, ['auth.passwordComplexityMinLength', 'service.name']);
      assert.deepEqual(config.storeTree(), { auth: { passwordComplexityMinLength: 12 }, service: { name: 'Stored' } });
      assert.equal(config.get('service:name'), 'Stored');
      assert.equal(config.get('service:home'), 'https://local.example', 'the local value stays for a refused row');
      assert.deepEqual(JSON.parse(await db.getPlatformKv('core-config-rev/core-a')).rev, 2);
      assert.deepEqual(pc.loadedState(), { rev: 2, keys: state.keys });
      await pc.unsetEntry(db, 'service.name', BY);
      await pc.unsetEntry(db, 'auth.passwordComplexityMinLength', BY);
      await pc.loadScope(config, db, 'core-a');
      assert.deepEqual(config.storeTree(), {});
      assert.equal(config.get('service:name'), 'Local', 'back to the local value');
    });

    it('[PLATCFG6] localOverrides: only a row hiding a different local value', async () => {
      await pc.setEntry(db, 'service.name', 'Stored', BY);
      await pc.setEntry(db, 'service.home', 'https://same.example', BY);
      await pc.setEntry(db, 'auth.passwordComplexityMinLength', 10, BY);
      const config = fakeConfig({ service: { name: 'Local', home: 'https://same.example', terms: 'https://t.example' } });
      assert.deepEqual(await pc.localOverrides(config, db), [{ key: 'service.name', local: 'Local' }]);
      assert.deepEqual(await pc.localOverrides(fakeConfig({}), db), [], 'no local value: no override');
    });

    it('[PLATCFG7] coresBehind: cores that did not load the current revision', async () => {
      assert.deepEqual(await pc.coresBehind(db, ['core-a', 'core-b']), [], 'nothing written yet');
      await pc.setEntry(db, 'service.name', 'A', BY);
      await pc.loadScope(fakeConfig(), db, 'core-a');
      await pc.loadScope(fakeConfig(), db, 'core-b');
      await pc.setEntry(db, 'service.name', 'B', BY);
      await pc.loadScope(fakeConfig(), db, 'core-a');
      assert.deepEqual(await pc.coresBehind(db, ['core-a', 'core-b', 'core-c']), [{ coreId: 'core-b', rev: 1 }, { coreId: 'core-c', rev: null }]);
    });

    it('[PLATCFG8] seed: copies the local values where no row exists, once', async () => {
      await pc.setEntry(db, 'service.home', 'https://stored.example', BY);
      const config = fakeConfig({ service: { name: 'Local name', home: 'https://local.example' }, auth: { passwordComplexityMinLength: 2 } });
      const out = await pc.seed(config, db, BY);
      assert.deepEqual(out.written, ['service.name']);
      assert.deepEqual(out.skipped.map((s) => s.key).sort(), ['auth.passwordComplexityMinLength', 'service.home']);
      assert.equal(out.rev, 2);
      assert.equal((await pc.getEntry(db, 'service.home')).value, 'https://stored.example', 'an existing row is kept');
      assert.equal((await pc.getEntry(db, 'service.name')).value, 'Local name');
      const again = await pc.seed(config, db, BY, ['service.name']);
      assert.deepEqual(again.written, []);
      assert.equal(again.rev, 2);
      await assert.rejects(pc.seed(config, db, BY, ['service.terms']), pc.UnknownKeyError);
    });

    it('[PLATCFG9] the periodic check reloads after a change written elsewhere', async () => {
      const config = fakeConfig({ platform: { configPollSeconds: 1 }, service: { name: 'Local' } });
      await pc.loadScope(config, db, 'core-a');
      const changes = [];
      const stop = pc.startPolling(config, db, 'core-a', (state) => changes.push(state.rev));
      try {
        await pc.setEntry(db, 'service.name', 'From core B', { kind: 'session', userId: 'u', coreId: 'core-b' });
        for (let i = 0; i < 30 && config.get('service:name') !== 'From core B'; i++) await sleep(100);
        assert.equal(config.get('service:name'), 'From core B');
        assert.deepEqual(changes, [1]);
      } finally {
        stop();
      }
      assert.equal(pc.pollSeconds(fakeConfig({ platform: { configPollSeconds: 0 } })), 15);
      assert.equal(pc.pollSeconds(fakeConfig({ platform: { configPollSeconds: 'x' } })), 15);
      assert.equal(pc.pollSeconds(fakeConfig({ platform: { configPollSeconds: 30 } })), 30);
    });

    it('[PLATCFG10] an unused store gets no write; the core revision is written only when it changes', async () => {
      const config = fakeConfig({ service: { name: 'Local' } });
      await pc.loadScope(config, db, 'core-a');
      assert.deepEqual(await db.listAllPlatformKvEntries(), [], 'upgrade with no row: nothing written');
      await pc.setEntry(db, 'service.name', 'A', BY);
      await pc.loadScope(config, db, 'core-a');
      const recorded = await db.getPlatformKv('core-config-rev/core-a');
      assert.equal(JSON.parse(recorded).rev, 1);
      await sleep(5);
      await pc.loadScope(config, db, 'core-a');
      assert.equal(await db.getPlatformKv('core-config-rev/core-a'), recorded, 'same revision: not written again');
    });

    it('[PLATCFG11] a write whose revision bump fails still answers; the periodic full reload loads the row', async () => {
      // A store whose writes of the revision row fail (the row writes go through).
      const failRev = (key) => { if (key === pc.REV_KEY) throw new Error('store unavailable (test)'); };
      const flaky = {
        getPlatformKv: (k) => db.getPlatformKv(k),
        setPlatformKv: (k, v) => db.setPlatformKv(k, v),
        setPlatformKvIfAbsent: async (k, v) => { failRev(k); return await db.setPlatformKvIfAbsent(k, v); },
        replacePlatformKvIfValue: async (k, e, n) => { failRev(k); return await db.replacePlatformKvIfValue(k, e, n); },
        listPlatformKvEntries: (p) => db.listPlatformKvEntries(p)
      };
      const config = fakeConfig({ platform: { configPollSeconds: 1 }, service: { name: 'Local' } });
      await pc.loadScope(config, db, 'core-a');
      const written = await pc.setEntry(flaky, 'service.name', 'Written', BY);
      assert.deepEqual({ rev: written.rev, revBumped: written.revBumped, after: written.after.value }, { rev: 0, revBumped: false, after: 'Written' });
      assert.equal((await pc.getEntry(db, 'service.name')).value, 'Written', 'the row landed');
      assert.equal(await pc.currentRev(db), 0, 'the revision did not move');
      const stop = pc.startPolling(config, db, 'core-a', undefined, { fullReloadEvery: 2 });
      try {
        for (let i = 0; i < 50 && config.get('service:name') !== 'Written'; i++) await sleep(100);
        assert.equal(config.get('service:name'), 'Written', 'loaded by the full reload, with no revision change');
      } finally {
        stop();
      }
      const removed = await pc.unsetEntry(flaky, 'service.name', BY);
      assert.deepEqual({ before: removed.before.value, revBumped: removed.revBumped }, { before: 'Written', revBumped: false });
      assert.equal(await pc.getEntry(db, 'service.name'), null);
    });
  });
}
