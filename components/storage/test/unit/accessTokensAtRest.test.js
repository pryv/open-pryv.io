/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const cuid = require('cuid');
const storage = require('storage');
const storages = require('storages');
const { indexedUserId, unindexUserIds } = require('test-helpers/src/indexedUserIds.ts');
const { createTokenProtection } = require('business/src/accesses/tokenProtection.ts');

/**
 * Access tokens and personal session ids are stored as a keyed hash plus an
 * encrypted copy, never in clear; above the engine the items are unchanged.
 * Against the engine the run selects (STORAGE_ENGINE), raw rows included.
 */
describe('[TKAR] access tokens and session ids at rest', function () {
  this.timeout(30000);
  let storageLayer, accesses, sessions, engine;
  const call = (obj, method, ...args) => promisify(obj[method].bind(obj))(...args);

  // ---- raw row access (engine-specific, read and write) ----

  function sqliteUserDb (userId) {
    const { UserBaseStorageDb } = require('storages/engines/sqlite/src/userBaseStorage/UserBaseStorageDb.ts');
    return UserBaseStorageDb.forUser(userId);
  }

  /** The stored rows of a user: `{ id, token, tokenHash, tokenEnc }`. */
  async function rawAccesses (userId) {
    if (engine === 'postgresql') {
      const res = await storages.databasePG.query('SELECT id, token, token_hash, token_enc FROM accesses WHERE user_id = $1', [userId]);
      return res.rows.map((r) => ({ id: r.id, token: r.token, tokenHash: r.token_hash, tokenEnc: r.token_enc }));
    }
    const udb = await sqliteUserDb(userId);
    return udb.db.prepare('SELECT id, data FROM accesses').all().map((r) => {
      const d = JSON.parse(r.data);
      return { id: r.id, token: d.token ?? null, tokenHash: d.tokenHash ?? null, tokenEnc: d.tokenEnc ?? null, raw: r.data };
    });
  }

  async function rawAccess (userId, id) {
    return (await rawAccesses(userId)).find((r) => r.id === id);
  }

  /** Write a row in a given stored form (`token`, `tokenHash`, `tokenEnc`, null = absent). */
  async function rawWrite (userId, id, form) {
    if (engine === 'postgresql') {
      await storages.databasePG.query('UPDATE accesses SET token = $1, token_hash = $2, token_enc = $3 WHERE user_id = $4 AND id = $5',
        [form.token, form.tokenHash, form.tokenEnc, userId, id]);
      return;
    }
    const udb = await sqliteUserDb(userId);
    const row = udb.db.prepare('SELECT data FROM accesses WHERE id = ?').get(id);
    const d = JSON.parse(row.data);
    delete d.token; delete d.tokenHash; delete d.tokenEnc;
    for (const k of ['token', 'tokenHash', 'tokenEnc']) if (form[k] != null) d[k] = form[k];
    udb.db.prepare('UPDATE accesses SET data = ? WHERE id = ?').run(JSON.stringify(d), id);
    // the first-use conversion runs again on the next use of this database
    udb.readyTables.delete('accesses');
  }

  /** The stored sessions: `{ id, idEnc, data }`. */
  async function rawSessions () {
    if (engine === 'postgresql') {
      const res = await storages.databasePG.query('SELECT id, id_enc, data FROM sessions');
      return res.rows.map((r) => ({ id: r.id, idEnc: r.id_enc, data: r.data }));
    }
    return storageLayer.connection.getDb().prepare('SELECT id, id_enc, data FROM sessions').all()
      .map((r) => ({ id: r.id, idEnc: r.id_enc, data: JSON.parse(r.data) }));
  }

  async function rawInsertClearSession (id, data, expires) {
    if (engine === 'postgresql') {
      await storages.databasePG.query('INSERT INTO sessions (id, data, expires) VALUES ($1, $2, $3)', [id, JSON.stringify(data), expires]);
      return;
    }
    storageLayer.connection.getDb().prepare('INSERT INTO sessions (id, data, expires) VALUES (?, ?, ?)').run(id, JSON.stringify(data), expires.getTime());
  }

  function newAccess (extra = {}) {
    return Object.assign({ id: cuid(), name: 'tk-' + cuid(), type: 'app', permissions: [{ streamId: '*', level: 'read' }] }, extra);
  }

  before(async () => {
    await storage.userLocalDirectory.init();
    storageLayer = await storage.getStorageLayer();
    accesses = storageLayer.accesses;
    sessions = storageLayer.sessions;
    engine = storageLayer.engine;
  });
  after(() => unindexUserIds());

  describe('[TKST] accesses', () => {
    let userId, otherUserId;
    before(async () => {
      userId = await indexedUserId();
      otherUserId = await indexedUserId();
    });
    after(async () => {
      await call(accesses, 'removeAll', userId);
      await call(accesses, 'removeAll', otherUserId);
    });

    it('[TKST1] no clear token in the stored row; findOne({ token }) returns the item with its clear token', async () => {
      const token = 'tkst1-' + cuid();
      const created = await call(accesses, 'insertOne', userId, newAccess({ token }));
      assert.strictEqual(created.token, token);
      const raw = await rawAccess(userId, created.id);
      assert.strictEqual(raw.token, null);
      assert.ok(raw.tokenHash != null && raw.tokenEnc != null);
      if (raw.raw != null) assert.ok(!raw.raw.includes(token), 'the stored data does not contain the token');
      assert.ok(!raw.tokenHash.includes(token) && !raw.tokenEnc.includes(token));
      const found = await call(accesses, 'findOne', userId, { token }, null);
      assert.strictEqual(found.id, created.id);
      assert.strictEqual(found.token, token);
      assert.ok(!('tokenHash' in found) && !('tokenEnc' in found) && !('token_hash' in found) && !('token_enc' in found));
      // a generated token too
      const gen = await call(accesses, 'insertOne', userId, newAccess());
      assert.ok(typeof gen.token === 'string' && gen.token.length > 20);
      assert.strictEqual((await rawAccess(userId, gen.id)).token, null);
      assert.strictEqual((await call(accesses, 'findOne', userId, { token: gen.token }, null)).id, gen.id);
    });

    it('[TKST2] the right token of another user finds nothing', async () => {
      const token = 'tkst2-' + cuid();
      const mine = await call(accesses, 'insertOne', userId, newAccess({ token }));
      assert.strictEqual(await call(accesses, 'findOne', otherUserId, { token }, null), null);
      // the same token chosen by two users is stored under two different hashes
      const other = await call(accesses, 'insertOne', otherUserId, newAccess({ token }));
      assert.notStrictEqual((await rawAccess(otherUserId, other.id)).tokenHash, (await rawAccess(userId, mine.id)).tokenHash);
      assert.strictEqual((await call(accesses, 'findOne', otherUserId, { token }, null)).id, other.id);
      assert.strictEqual((await call(accesses, 'findOne', userId, { token }, null)).id, mine.id);
    });

    it('[TKST3] an update setting the token: old one no longer found, new one found, stored row consistent', async () => {
      const oldToken = 'tkst3-old-' + cuid();
      const newToken = 'tkst3-new-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: oldToken }));
      const before = await rawAccess(userId, a.id);
      const updated = await call(accesses, 'updateOne', userId, { id: a.id }, { token: newToken });
      assert.strictEqual(updated.token, newToken);
      assert.strictEqual(await call(accesses, 'findOne', userId, { token: oldToken }, null), null);
      assert.strictEqual((await call(accesses, 'findOne', userId, { token: newToken }, null)).id, a.id);
      const after = await rawAccess(userId, a.id);
      assert.strictEqual(after.token, null);
      assert.notStrictEqual(after.tokenHash, before.tokenHash);
      // $set form
      const third = 'tkst3-third-' + cuid();
      await call(accesses, 'updateOne', userId, { id: a.id }, { $set: { token: third } });
      assert.strictEqual((await call(accesses, 'findOne', userId, { token: third }, null)).id, a.id);
      assert.strictEqual(await call(accesses, 'findOne', userId, { token: newToken }, null), null);
    });

    it('[TKST4] a compare-and-set update with the token in the query matches only the current token', async () => {
      const t1 = 'tkst4-a-' + cuid();
      const t2 = 'tkst4-b-' + cuid();
      const t3 = 'tkst4-c-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: t1, type: 'personal' }));
      const first = await call(accesses, 'updateOne', userId, { name: a.name, type: 'personal', token: t1 }, { token: t2 });
      assert.strictEqual(first.token, t2);
      const stale = await call(accesses, 'updateOne', userId, { name: a.name, type: 'personal', token: t1 }, { token: t3 });
      assert.strictEqual(stale, null);
      assert.strictEqual((await call(accesses, 'findOne', userId, { id: a.id }, null)).token, t2);
      // other operators on the token
      const inRes = await call(accesses, 'find', userId, { token: { $in: [t2, 'nope'] } }, null);
      assert.deepStrictEqual(inRes.map((x) => x.id), [a.id]);
      const neRes = await call(accesses, 'find', userId, { id: a.id, token: { $ne: t2 } }, null);
      assert.strictEqual(neRes.length, 0);
    });

    it('[TKST5] a duplicate live token is refused as isDuplicateIndex(\'token\'), allowed once the first is deleted, shared by history rows', async () => {
      const token = 'tkst5-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      await assert.rejects(call(accesses, 'insertOne', userId, newAccess({ token })), (err) => {
        assert.strictEqual(typeof err.isDuplicateIndex, 'function');
        assert.ok(err.isDuplicateIndex('token'));
        return true;
      });
      await call(accesses, 'snapshotHead', userId, a.id);
      await call(accesses, 'delete', userId, { id: a.id });
      const b = await call(accesses, 'insertOne', userId, newAccess({ token }));
      assert.strictEqual((await call(accesses, 'findOne', userId, { token }, null)).id, b.id);
    });

    it('[TKST6] history and deleted rows open to the same token; exportAll / importAll keep tokens and integrity', async () => {
      // A user of its own: the rows of the other tests are updated without a
      // recomputed hash, which an import recomputes.
      const userId = await indexedUserId();
      const token = 'tkst6-' + cuid();
      await call(accesses, 'insertOne', userId, newAccess({ token: 'tkst6-live-' + cuid() }));
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      await call(accesses, 'snapshotHead', userId, a.id);
      const history = await accesses.findHistory(userId, a.id);
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].token, token);
      await call(accesses, 'delete', userId, { id: a.id });
      const all = await call(accesses, 'findIncludingDeletionsAndVersions', userId, {}, null);
      const mine = all.filter((x) => x.id === a.id || x.headId === a.id);
      assert.strictEqual(mine.length, 2);
      for (const x of mine) assert.strictEqual(x.token, token);
      const exported = await call(accesses, 'exportAll', userId);
      const target = await indexedUserId();
      try {
        await call(accesses, 'importAll', target, exported);
        const reimported = await call(accesses, 'exportAll', target);
        const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
        const src = byId(exported);
        const dst = byId(reimported);
        assert.deepStrictEqual(Object.keys(dst).sort(), Object.keys(src).sort());
        for (const id of Object.keys(src)) {
          assert.strictEqual(dst[id].token, src[id].token, 'token of ' + id);
          assert.strictEqual(dst[id].integrity, src[id].integrity, 'integrity of ' + id);
        }
        for (const r of await rawAccesses(target)) assert.strictEqual(r.token, null);
      } finally {
        await call(accesses, 'removeAll', target);
        await call(accesses, 'removeAll', userId);
      }
    });

    it('[TKST7] a tampered encrypted copy makes the read throw the typed error, never an item without token', async () => {
      const token = 'tkst7-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      const raw = await rawAccess(userId, a.id);
      const other = createTokenProtection('another key');
      await rawWrite(userId, a.id, { token: null, tokenHash: raw.tokenHash, tokenEnc: other.sealAccessToken(userId, raw.tokenHash, token) });
      await assert.rejects(call(accesses, 'findOne', userId, { id: a.id }, null), (err) => {
        assert.strictEqual(err.name, 'TokenUnreadableError');
        assert.strictEqual(err.accessId, a.id);
        return true;
      });
      await rawWrite(userId, a.id, raw);
      assert.strictEqual((await call(accesses, 'findOne', userId, { token }, null)).id, a.id);
    });

    it('[TKUR1] a whole-store export asked to report unreadable rows returns the others and names that one; without it the export still throws', async () => {
      const u = await indexedUserId();
      try {
        const good = await call(accesses, 'insertOne', u, newAccess({ token: 'tkur1-good-' + cuid() }));
        const bad = await call(accesses, 'insertOne', u, newAccess({ token: 'tkur1-bad-' + cuid() }));
        const raw = await rawAccess(u, bad.id);
        const other = createTokenProtection('tkur1-other-key');
        await rawWrite(u, bad.id, { token: null, tokenHash: raw.tokenHash, tokenEnc: other.sealAccessToken(u, raw.tokenHash, bad.token) });
        const reported = [];
        const items = await promisify((cb) => accesses.exportAll(u, cb, { onUnreadableRow: (id, reason) => reported.push({ id, reason }) }))();
        assert.deepStrictEqual(items.map((x) => x.id), [good.id]);
        assert.strictEqual(items[0].token, good.token);
        assert.strictEqual(reported.length, 1);
        assert.strictEqual(reported[0].id, bad.id);
        assert.ok(!reported[0].reason.includes(bad.token), 'the reason does not carry the token');
        await assert.rejects(call(accesses, 'exportAll', u), (err) => err.name === 'TokenUnreadableError');
        await assert.rejects(call(accesses, 'findOne', u, { id: bad.id }, null), (err) => err.name === 'TokenUnreadableError');
      } finally {
        await call(accesses, 'removeAll', u);
      }
    });

    it('[TKUR2] the integrity check reports an access whose token does not open and checks the others', async () => {
      const u = await indexedUserId();
      const IntegrityCheck = require('business/src/integrity/IntegrityCheck.ts').default;
      const checker = await new IntegrityCheck().init();
      try {
        await call(accesses, 'insertOne', u, newAccess({ token: 'tkur2-a-' + cuid() }));
        await call(accesses, 'insertOne', u, newAccess({ token: 'tkur2-b-' + cuid() }));
        const bad = await call(accesses, 'insertOne', u, newAccess({ token: 'tkur2-bad-' + cuid() }));
        const raw = await rawAccess(u, bad.id);
        const other = createTokenProtection('tkur2-other-key');
        await rawWrite(u, bad.id, { token: null, tokenHash: raw.tokenHash, tokenEnc: other.sealAccessToken(u, raw.tokenHash, bad.token) });
        const report = await checker.checkUser(u);
        assert.strictEqual(report.accesses.status, 'checked');
        assert.strictEqual(report.accesses.checked, 3);
        assert.strictEqual(report.accesses.errors.length, 1, JSON.stringify(report.accesses.errors));
        assert.strictEqual(report.accesses.errors[0].accessId, bad.id);
        assert.match(report.accesses.errors[0].error, /stored token unreadable/);
        assert.strictEqual(report.ok, false);
      } finally {
        await call(accesses, 'removeAll', u);
      }
    });

    it('[TKST8] a one-character and a 500-character token round trip', async () => {
      for (const token of ['x', 'y'.repeat(500)]) {
        const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
        assert.strictEqual((await call(accesses, 'findOne', userId, { token }, null)).id, a.id);
        assert.strictEqual((await rawAccess(userId, a.id)).token, null);
      }
    });

    it('[TKST9] an update setting token to null (the deletion scrub) leaves neither the token nor its pair in the stored row', async () => {
      const token = 'tkst9-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      const b = await call(accesses, 'insertOne', userId, newAccess({ token: 'tkst9-b-' + cuid() }));
      // the scrub's form: plain fields with `modified` (integrity recomputed)
      const updated = await call(accesses, 'updateOne', userId, { id: a.id }, { clientData: { k: 'v' }, modified: Date.now() / 1000, token: null });
      assert.ok(updated.token == null);
      await call(accesses, 'updateMany', userId, { id: b.id }, { $set: { token: null } });
      for (const id of [a.id, b.id]) {
        const raw = await rawAccess(userId, id);
        assert.strictEqual(raw.token, null, id);
        assert.strictEqual(raw.tokenHash, null, id);
        assert.strictEqual(raw.tokenEnc, null, id);
        if (raw.raw != null) assert.ok(!raw.raw.includes('tokenHash') && !raw.raw.includes('tokenEnc'), raw.raw);
      }
      assert.strictEqual(await call(accesses, 'findOne', userId, { token }, null), null);
      assert.ok((await call(accesses, 'findOne', userId, { id: a.id }, null)).token == null);
    });

    it('[TKOR1] a token clause inside $or finds by token; an operator there is refused', async () => {
      const token = 'tkor1-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      const found = await call(accesses, 'find', userId, { $or: [{ token }, { id: 'tkor1-none' }] }, null);
      assert.deepStrictEqual(found.map((x) => x.id), [a.id]);
      assert.strictEqual(found[0].token, token);
      const none = await call(accesses, 'find', userId, { $or: [{ token: 'tkor1-wrong' }, { id: 'tkor1-none' }] }, null);
      assert.strictEqual(none.length, 0);
      await assert.rejects(call(accesses, 'find', userId, { $or: [{ token: { $in: [token] } }] }, null), /inside \$or takes a plain value/);
    });

    it('[TKPJ1] a positive projection naming token returns the clear token', async () => {
      const token = 'tkpj1-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      const one = await call(accesses, 'findOne', userId, { id: a.id }, { projection: { token: 1, name: 1 } });
      assert.strictEqual(one.token, token);
      assert.strictEqual(one.name, a.name);
      assert.ok(!('tokenHash' in one) && !('tokenEnc' in one) && !('token_hash' in one) && !('token_enc' in one));
      const many = await call(accesses, 'find', userId, { id: a.id }, { projection: { token: 1 } });
      assert.strictEqual(many.length, 1);
      assert.strictEqual(many[0].token, token);
    });
  });

  describe('[TKSS] sessions', () => {
    afterEach(async () => { await call(sessions, 'remove', { username: 'tkss-user' }); });

    it('[TKSS1] generate returns an id that get resolves; the stored id is not that id', async () => {
      const id = await call(sessions, 'generate', { username: 'tkss-user', appId: 'tkss1' }, {});
      assert.deepStrictEqual(await call(sessions, 'get', id), { username: 'tkss-user', appId: 'tkss1' });
      const raw = (await rawSessions()).find((r) => r.data?.appId === 'tkss1');
      assert.ok(raw != null);
      assert.notStrictEqual(raw.id, id);
      assert.ok(!raw.id.includes(id) && raw.idEnc != null && !raw.idEnc.includes(id));
    });

    it('[TKSS2] getMatching returns the clear id; touch, expireNow and destroy act on it', async () => {
      const id = await call(sessions, 'generate', { username: 'tkss-user', appId: 'tkss2' }, {});
      assert.strictEqual(await call(sessions, 'getMatching', { username: 'tkss-user', appId: 'tkss2' }), id);
      await call(sessions, 'touch', id);
      await call(sessions, 'expireNow', id);
      assert.strictEqual(await call(sessions, 'get', id), null);
      const id2 = await call(sessions, 'generate', { username: 'tkss-user', appId: 'tkss2b' }, {});
      await call(sessions, 'destroy', id2);
      assert.strictEqual(await call(sessions, 'get', id2), null);
      assert.strictEqual((await rawSessions()).filter((r) => r.data?.appId === 'tkss2b').length, 0);
    });

    it('[TKSS3] removeAllExcept(query, id) keeps exactly that session', async () => {
      const keep = await call(sessions, 'generate', { username: 'tkss-user', appId: 'tkss3' }, {});
      const drop = await call(sessions, 'generate', { username: 'tkss-user', appId: 'tkss3' }, {});
      await call(sessions, 'removeAllExcept', { username: 'tkss-user' }, keep);
      assert.ok(await call(sessions, 'get', keep));
      assert.strictEqual(await call(sessions, 'get', drop), null);
    });

    it('[TKSS4] importAll then exportAll round trip', async () => {
      const id = 'tkss4-' + cuid();
      const expires = new Date(Date.now() + 3600000);
      await call(sessions, 'importAll', [{ _id: id, data: { username: 'tkss-user', appId: 'tkss4' }, expires }]);
      assert.deepStrictEqual(await call(sessions, 'get', id), { username: 'tkss-user', appId: 'tkss4' });
      const exported = (await call(sessions, 'exportAll')).find((d) => d.data?.appId === 'tkss4');
      assert.strictEqual(exported._id, id);
      assert.notStrictEqual((await rawSessions()).find((r) => r.data?.appId === 'tkss4').id, id);
    });

    it('[TKSS5] touch, expireNow, destroy and removeAllExcept hand a non-string id to the callback, never throw', async () => {
      const cases = [['touch', [42]], ['expireNow', [42]], ['destroy', [42]], ['removeAllExcept', [{ username: 'tkss-user' }, 42]]];
      for (const [method, args] of cases) {
        let thrown = null;
        const err = await new Promise((resolve) => {
          try { sessions[method](...args, (e) => resolve(e)); } catch (e) { thrown = e; resolve(null); }
        });
        assert.strictEqual(thrown, null, method + ' threw instead of calling back');
        assert.match(err?.message ?? '', /session id must be a string/, method);
      }
    });
  });

  describe('[TKMG] conversion of stored clear tokens', () => {
    let userId;
    const tokensAtRest = () => storages.getTokensAtRest();
    before(async () => { userId = await indexedUserId(); });
    after(async () => { await call(accesses, 'removeAll', userId); });

    /** Live, history, deleted and token-less rows written back in the clear form. */
    async function clearFormRows () {
      const live = await call(accesses, 'insertOne', userId, newAccess({ token: 'tkmg-live-' + cuid() }));
      await call(accesses, 'snapshotHead', userId, live.id);
      const del = await call(accesses, 'insertOne', userId, newAccess({ token: 'tkmg-del-' + cuid() }));
      await call(accesses, 'delete', userId, { id: del.id });
      const items = await call(accesses, 'findIncludingDeletionsAndVersions', userId, {}, null);
      for (const it of items) await rawWrite(userId, it.id, { token: it.token, tokenHash: null, tokenEnc: null });
      return { live, del, items };
    }

    it('[TKMG1] rows in the clear form (live, deleted, history) are protected by the pass; a second run changes nothing; tokens authenticate', async () => {
      const { live, items } = await clearFormRows();
      assert.ok((await rawAccesses(userId)).every((r) => r.token != null));
      if (engine === 'sqlite') {
        const { removeTokenMarker } = require('storages/engines/sqlite/src/user/AccessesSQLite.ts');
        removeTokenMarker();
      }
      const res = await tokensAtRest().protectTokensAtRest();
      assert.ok(res.accesses >= items.length, JSON.stringify(res));
      for (const r of await rawAccesses(userId)) {
        assert.strictEqual(r.token, null);
        assert.ok(r.tokenHash != null && r.tokenEnc != null);
      }
      const again = await tokensAtRest().protectTokensAtRest();
      assert.strictEqual(again.accesses, 0);
      assert.strictEqual((await call(accesses, 'findOne', userId, { token: live.token }, null)).id, live.id);
      const after = await call(accesses, 'findIncludingDeletionsAndVersions', userId, {}, null);
      const tokens = (arr) => Object.fromEntries(arr.map((x) => [x.id, x.token]));
      assert.deepStrictEqual(tokens(after), tokens(items));
    });

    it('[TKMG2] a row with a stale hash and a clear token (written by a previous image) ends with the hash of the clear token', async () => {
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: 'tkmg2-old-' + cuid() }));
      const stale = await rawAccess(userId, a.id);
      const current = 'tkmg2-new-' + cuid();
      await rawWrite(userId, a.id, { token: current, tokenHash: stale.tokenHash, tokenEnc: stale.tokenEnc });
      if (engine === 'postgresql') await tokensAtRest().protectTokensAtRest();
      // SQLite: the first use of the database converts it
      assert.strictEqual((await call(accesses, 'findOne', userId, { token: current }, null)).id, a.id);
      const raw = await rawAccess(userId, a.id);
      assert.strictEqual(raw.token, null);
      assert.notStrictEqual(raw.tokenHash, stale.tokenHash);
      assert.strictEqual(await call(accesses, 'findOne', userId, { token: 'tkmg2-old-x' }, null), null);
    });

    it('[TKMG3] SQLite: the walk writes the marker with the key id; a database added after it is converted at first use', async function () {
      if (engine !== 'sqlite') this.skip();
      const mod = require('storages/engines/sqlite/src/user/AccessesSQLite.ts');
      mod.removeTokenMarker();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: 'tkmg3-' + cuid() }));
      await rawWrite(userId, a.id, { token: a.token, tokenHash: null, tokenEnc: null });
      await tokensAtRest().protectTokensAtRest();
      assert.strictEqual(mod.tokenMarkerKid(), accesses.tokenProtection.kid);
      assert.strictEqual((await rawAccess(userId, a.id)).token, null);
      // a database written in clear after the walk (restored by file copy)
      const later = await indexedUserId();
      try {
        const b = await call(accesses, 'insertOne', later, newAccess({ token: 'tkmg3-later-' + cuid() }));
        await rawWrite(later, b.id, { token: b.token, tokenHash: null, tokenEnc: null });
        const { UserBaseStorageDb } = require('storages/engines/sqlite/src/userBaseStorage/UserBaseStorageDb.ts');
        UserBaseStorageDb.evict(later); // a new handle, as after a file copy
        assert.strictEqual((await call(accesses, 'findOne', later, { token: b.token }, null)).id, b.id);
        assert.strictEqual((await rawAccess(later, b.id)).token, null);
      } finally {
        await call(accesses, 'removeAll', later);
      }
    });

    it('[TKMG4] sessions keyed by their clear id are converted in place, expired ones dropped; a live one still resolves', async () => {
      const live = 'tkmg4-live-' + cuid();
      const expired = 'tkmg4-expired-' + cuid();
      await rawInsertClearSession(live, { username: 'tkmg4-user', appId: 'live' }, new Date(Date.now() + 3600000));
      await rawInsertClearSession(expired, { username: 'tkmg4-user', appId: 'expired' }, new Date(Date.now() - 1000));
      try {
        const res = engine === 'postgresql'
          ? await tokensAtRest().protectTokensAtRest()
          : Object.assign(await sessions.protectClearRows(), {});
        if (engine === 'postgresql') assert.ok(res.sessions >= 1 && res.sessionsExpired >= 1, JSON.stringify(res));
        const raw = (await rawSessions()).filter((r) => r.data?.username === 'tkmg4-user');
        assert.strictEqual(raw.length, 1);
        assert.notStrictEqual(raw[0].id, live);
        assert.ok(raw[0].idEnc != null);
        assert.deepStrictEqual(await call(sessions, 'get', live), { username: 'tkmg4-user', appId: 'live' });
        assert.strictEqual(await call(sessions, 'getMatching', { username: 'tkmg4-user', appId: 'live' }), live);
      } finally {
        await call(sessions, 'remove', { username: 'tkmg4-user' });
      }
    });

    it('[TKMG5] the items, integrity included, are identical before and after the pass', async () => {
      const { items } = await clearFormRows();
      const before = await call(accesses, 'findIncludingDeletionsAndVersions', userId, {}, null);
      if (engine === 'sqlite') require('storages/engines/sqlite/src/user/AccessesSQLite.ts').removeTokenMarker();
      await tokensAtRest().protectTokensAtRest();
      const after = await call(accesses, 'findIncludingDeletionsAndVersions', userId, {}, null);
      const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
      assert.deepStrictEqual(byId(after), byId(before));
      assert.ok(items.length >= 3);
      for (const it of before) {
        if (it.integrity == null) continue;
        assert.strictEqual(byId(after)[it.id].integrity, it.integrity);
      }
    });

    it('[TKMG7] PostgreSQL: a clear row duplicating the token of a protected live access is left in clear, the others converted', async function () {
      if (engine !== 'postgresql') this.skip();
      const token = 'tkmg7-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      const b = await call(accesses, 'insertOne', userId, newAccess({ token: 'tkmg7-b-' + cuid() }));
      const c = await call(accesses, 'insertOne', userId, newAccess({ token: 'tkmg7-c-' + cuid() }));
      await rawWrite(userId, b.id, { token, tokenHash: null, tokenEnc: null });
      await rawWrite(userId, c.id, { token: c.token, tokenHash: null, tokenEnc: null });
      try {
        const res = await tokensAtRest().protectTokensAtRest();
        assert.strictEqual(res.accessesSkipped, 1, JSON.stringify(res));
        assert.strictEqual((await rawAccess(userId, b.id)).token, token);
        assert.strictEqual((await rawAccess(userId, c.id)).token, null);
        assert.strictEqual((await call(accesses, 'findOne', userId, { token }, null)).id, a.id);
      } finally {
        await call(accesses, 'removeOne', userId, { id: b.id });
      }
    });

    it('[TKMG6] PostgreSQL: idx_access_token is gone, idx_access_token_hash is there', async function () {
      if (engine !== 'postgresql') this.skip();
      const res = await storages.databasePG.query('SELECT indexname, indexdef FROM pg_indexes WHERE tablename = \'accesses\'');
      const names = res.rows.map((r) => r.indexname);
      assert.ok(!names.includes('idx_access_token'), names.join(', '));
      const hashIdx = res.rows.find((r) => r.indexname === 'idx_access_token_hash');
      assert.ok(hashIdx != null, names.join(', '));
      assert.match(hashIdx.indexdef, /UNIQUE/);
      assert.match(hashIdx.indexdef, /head_id IS NULL/);
    });

    it('[TKMG8] PostgreSQL: a batch another process converted meanwhile does not end the pass; the rows after it are converted', async function () {
      if (engine !== 'postgresql') this.skip();
      const { AccessesPG } = require('storages/engines/postgresql/src/user/AccessesPG.ts');
      const noIntegrity = { isActive: false, set: () => {}, rowFormHash: () => '' };
      const items = [];
      for (let i = 0; i < 5; i++) items.push(await call(accesses, 'insertOne', userId, newAccess({ token: 'tkmg8-' + i + '-' + cuid() })));
      for (const it of items) await rawWrite(userId, it.id, { token: it.token, tokenHash: null, tokenEnc: null });
      const db = storages.databasePG;
      const other = new AccessesPG(db, noIntegrity, accesses.tokenProtection);
      let interceptions = 0;
      // A second master on the same database converts the first batch between our select and our update.
      const racing = {
        query: async (sql, params) => {
          if (interceptions === 0 && sql.startsWith('UPDATE accesses a SET token_hash')) {
            interceptions++;
            const [uids, ids, toks] = params;
            for (let i = 0; i < ids.length; i++) {
              const cols = other.protectedColumns(uids[i], toks[i]);
              await db.query('UPDATE accesses SET token_hash = $1, token_enc = $2, token = NULL WHERE user_id = $3 AND id = $4 AND token = $5',
                [cols.token_hash, cols.token_enc, uids[i], ids[i], toks[i]]);
            }
          }
          return db.query(sql, params);
        }
      };
      const first = new AccessesPG(racing, noIntegrity, accesses.tokenProtection);
      first.tokenBatchSize = 2;
      await first.protectClearRows();
      assert.strictEqual(interceptions, 1);
      for (const it of items) assert.strictEqual((await rawAccess(userId, it.id)).token, null, 'row ' + it.id + ' converted');
      for (const it of items) assert.strictEqual((await call(accesses, 'findOne', userId, { token: it.token }, null)).id, it.id);
    });

    it('[TKPR1] the boot probe finds a row under another key whatever its key id sorts before or after the current one', async () => {
      const kid = accesses.tokenProtection.kid;
      const keyWithKid = (pred) => {
        for (let i = 0; ; i++) {
          const p = createTokenProtection('tkpr1-key-' + i + '-' + cuid());
          if (pred(p.kid)) return p;
        }
      };
      const lower = keyWithKid((k) => k < kid);
      const higher = keyWithKid((k) => k > kid);
      // rows under the current key around the foreign one: both bounds matter
      await call(accesses, 'insertOne', userId, newAccess({ token: 'tkpr1-current-' + cuid() }));
      await call(sessions, 'generate', { username: 'tkpr1-keep' }, {});
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: 'tkpr1-' + cuid() }));
      const raw = await rawAccess(userId, a.id);
      try {
        for (const previous of [lower, higher]) {
          const h = previous.hashAccessToken(userId, a.token);
          await rawWrite(userId, a.id, { token: null, tokenHash: h, tokenEnc: previous.sealAccessToken(userId, h, a.token) });
          if (engine === 'postgresql') {
            await assert.rejects(tokensAtRest().probeTokensAtRest(), (err) => err.name === 'ForeignTokenKeyError', 'access under ' + previous.kid);
          } else {
            await assert.rejects(call(accesses, 'findOne', userId, { id: a.id }, null), (err) => err.name === 'ForeignTokenKeyError');
          }
        }
        await rawWrite(userId, a.id, raw);
        await tokensAtRest().probeTokensAtRest();
        // a session alone under another key
        for (const previous of [lower, higher]) {
          const sid = 'tkpr1-session-' + cuid();
          const sh = previous.hashSessionId(sid);
          if (engine === 'postgresql') {
            await storages.databasePG.query('INSERT INTO sessions (id, id_enc, data, expires) VALUES ($1, $2, $3, $4)',
              [sh, previous.sealSessionId(sh, sid), JSON.stringify({ username: 'tkpr1-user' }), new Date(Date.now() + 3600000)]);
          } else {
            storageLayer.connection.getDb().prepare('INSERT INTO sessions (id, id_enc, data, expires) VALUES (?, ?, ?, ?)')
              .run(sh, previous.sealSessionId(sh, sid), JSON.stringify({ username: 'tkpr1-user' }), Date.now() + 3600000);
          }
          try {
            await assert.rejects(tokensAtRest().probeTokensAtRest(), (err) => err.name === 'ForeignTokenKeyError', 'session under ' + previous.kid);
          } finally {
            await call(sessions, 'remove', { username: 'tkpr1-user' });
          }
        }
        await tokensAtRest().probeTokensAtRest();
      } finally {
        await rawWrite(userId, a.id, raw);
        await call(sessions, 'remove', { username: 'tkpr1-keep' });
      }
    });

    it('[TKPR2] the probe indexes are there: rows in clear and the key id of protected rows', async () => {
      if (engine === 'postgresql') {
        const res = await storages.databasePG.query('SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ' +
          '(\'idx_access_token_kid\', \'idx_session_clear\', \'idx_session_kid\')');
        const defs = Object.fromEntries(res.rows.map((r) => [r.indexname, r.indexdef]));
        assert.match(defs.idx_access_token_kid ?? '', /left"?\(token_hash, 9\)/);
        assert.match(defs.idx_session_clear ?? '', /id_enc IS NULL/);
        assert.match(defs.idx_session_kid ?? '', /left"?\(id, 9\)/);
        return;
      }
      const names = storageLayer.connection.getDb().prepare('SELECT name FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'sessions\'').all().map((r) => r.name);
      assert.ok(names.includes('sessions_clear') && names.includes('sessions_kid'), names.join(', '));
    });
  });

  describe('[TKTL] rollback, re-key and the guard', () => {
    let userId;
    const tokensAtRest = () => storages.getTokensAtRest();
    before(async () => { userId = await indexedUserId(); });
    after(async () => { await call(accesses, 'removeAll', userId); });

    it('[TKTL1] unprotect writes the clear form back (what the previous image reads); the pass protects it again', async () => {
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: 'tktl1-' + cuid() }));
      const sid = await call(sessions, 'generate', { username: 'tktl1-user' }, {});
      try {
        await tokensAtRest().unprotectTokensAtRest();
        const raw = await rawAccess(userId, a.id);
        assert.strictEqual(raw.token, a.token);
        assert.strictEqual(raw.tokenHash, null);
        assert.strictEqual(raw.tokenEnc, null);
        const s = (await rawSessions()).find((r) => r.data?.username === 'tktl1-user');
        assert.strictEqual(s.id, sid);
        assert.strictEqual(s.idEnc, null);
        if (engine === 'postgresql') {
          const idx = await storages.databasePG.query('SELECT 1 FROM pg_indexes WHERE indexname = \'idx_access_token\'');
          assert.strictEqual(idx.rows.length, 1);
        } else {
          assert.strictEqual(require('storages/engines/sqlite/src/user/AccessesSQLite.ts').tokenMarkerKid(), null);
          assert.strictEqual(require('storages/engines/sqlite/src/user/AccessesSQLite.ts').tokensUnprotected(), true);
        }
        await tokensAtRest().protectTokensAtRest();
        if (engine === 'sqlite') assert.strictEqual(require('storages/engines/sqlite/src/user/AccessesSQLite.ts').tokensUnprotected(), false);
        assert.strictEqual((await rawAccess(userId, a.id)).token, null);
        assert.notStrictEqual((await rawSessions()).find((r) => r.data?.username === 'tktl1-user').id, sid);
        assert.strictEqual((await call(accesses, 'findOne', userId, { token: a.token }, null)).id, a.id);
        assert.ok(await call(sessions, 'get', sid));
        if (engine === 'postgresql') {
          const idx = await storages.databasePG.query('SELECT 1 FROM pg_indexes WHERE indexname = \'idx_access_token\'');
          assert.strictEqual(idx.rows.length, 0);
        }
      } finally {
        await call(sessions, 'remove', { username: 'tktl1-user' });
      }
    });

    it('[TKTL2] [TKTL3] rows under a previous key: the guard refuses, rekey makes them found again, a second rekey is a no-op', async () => {
      const previousKey = 'tktl-previous-key-' + cuid();
      const previous = createTokenProtection(previousKey);
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: 'tktl2-' + cuid() }));
      const prevHash = previous.hashAccessToken(userId, a.token);
      await rawWrite(userId, a.id, { token: null, tokenHash: prevHash, tokenEnc: previous.sealAccessToken(userId, prevHash, a.token) });
      const sid = 'tktl2-session-' + cuid();
      const sh = previous.hashSessionId(sid);
      if (engine === 'postgresql') {
        await storages.databasePG.query('INSERT INTO sessions (id, id_enc, data, expires) VALUES ($1, $2, $3, $4)',
          [sh, previous.sealSessionId(sh, sid), JSON.stringify({ username: 'tktl2-user' }), new Date(Date.now() + 3600000)]);
      } else {
        storageLayer.connection.getDb().prepare('INSERT INTO sessions (id, id_enc, data, expires) VALUES (?, ?, ?, ?)')
          .run(sh, previous.sealSessionId(sh, sid), JSON.stringify({ username: 'tktl2-user' }), Date.now() + 3600000);
      }
      try {
        assert.strictEqual(await call(sessions, 'get', sid), null);
        // [TKTL3] the boot pass refuses, naming the tool
        await assert.rejects(tokensAtRest().protectTokensAtRest(), (err) => {
          assert.strictEqual(err.name, 'ForeignTokenKeyError');
          assert.match(err.message, /access-tokens\.js rekey/);
          return true;
        });
        if (engine === 'sqlite') {
          // a database first used in a process refuses too
          const { UserBaseStorageDb } = require('storages/engines/sqlite/src/userBaseStorage/UserBaseStorageDb.ts');
          UserBaseStorageDb.evict(userId);
          await assert.rejects(call(accesses, 'findOne', userId, { token: a.token }, null), (err) => err.name === 'ForeignTokenKeyError');
        } else {
          assert.strictEqual(await call(accesses, 'findOne', userId, { token: a.token }, null), null);
        }
        const status = await tokensAtRest().tokensAtRestStatus();
        assert.ok(status.accesses.protectedOtherKeys[previous.kid] >= 1, JSON.stringify(status));
        const res = await tokensAtRest().rekeyTokensAtRest([createTokenProtection('unrelated'), previous]);
        assert.ok(res.accesses >= 1 && res.sessions >= 1, JSON.stringify(res));
        assert.strictEqual(res.remaining, false);
        assert.strictEqual((await call(accesses, 'findOne', userId, { token: a.token }, null)).id, a.id);
        assert.ok(accesses.tokenProtection.ownsHash((await rawAccess(userId, a.id)).tokenHash));
        assert.deepStrictEqual(await call(sessions, 'get', sid), { username: 'tktl2-user' });
        const again = await tokensAtRest().rekeyTokensAtRest([previous]);
        assert.strictEqual(again.accesses, 0);
        assert.strictEqual(again.sessions, 0);
        await tokensAtRest().protectTokensAtRest(); // the guard passes again
      } finally {
        await call(sessions, 'remove', { username: 'tktl2-user' });
      }
    });

    it('[TKTL4] after unprotect, a fresh storage init, status and an export leave tokens and session ids in clear; the start pass converts them', async () => {
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: 'tktl4-' + cuid() }));
      const sid = await call(sessions, 'generate', { username: 'tktl4-user' }, {});
      const sqliteAccesses = () => require('storages/engines/sqlite/src/user/AccessesSQLite.ts');
      try {
        await tokensAtRest().unprotectTokensAtRest();
        if (engine === 'sqlite') {
          assert.strictEqual(sqliteAccesses().tokensUnprotected(), true);
          // as in another process: its storage init, then its first use of the user database
          const { UserBaseStorageDb } = require('storages/engines/sqlite/src/userBaseStorage/UserBaseStorageDb.ts');
          UserBaseStorageDb.evict(userId);
          const fresh = {};
          await require('storages/engines/sqlite/src/index.ts').initStorageLayer(fresh, null,
            { tokenProtection: accesses.tokenProtection, integrityAccesses: accesses.integrityAccesses });
          fresh.connection.close();
        }
        const status = await tokensAtRest().tokensAtRestStatus();
        assert.ok(status.accesses.clear >= 1 && status.sessions.clear >= 1, JSON.stringify(status));
        const exported = await call(accesses, 'exportAll', userId);
        assert.strictEqual(exported.find((x) => x.id === a.id).token, a.token);
        await call(sessions, 'exportAll');
        const raw = await rawAccess(userId, a.id);
        assert.strictEqual(raw.token, a.token);
        assert.strictEqual(raw.tokenHash, null);
        assert.strictEqual(raw.tokenEnc, null);
        const s = (await rawSessions()).find((r) => r.data?.username === 'tktl4-user');
        assert.strictEqual(s.id, sid);
        assert.strictEqual(s.idEnc, null);
        // the start (or `bin/migrate.js up`) ends the rollback state and converts
        await tokensAtRest().protectTokensAtRest();
        if (engine === 'sqlite') assert.strictEqual(sqliteAccesses().tokensUnprotected(), false);
        assert.strictEqual((await rawAccess(userId, a.id)).token, null);
        assert.notStrictEqual((await rawSessions()).find((r) => r.data?.username === 'tktl4-user').id, sid);
        assert.strictEqual((await call(accesses, 'findOne', userId, { token: a.token }, null)).id, a.id);
        assert.ok(await call(sessions, 'get', sid));
      } finally {
        await tokensAtRest().protectTokensAtRest(); // leave the store protected whatever happened above
        await call(sessions, 'remove', { username: 'tktl4-user' });
      }
    });

    it('[TKTL5] unprotect keeps the clear token of a row that also holds a stale pair', async () => {
      const a = await call(accesses, 'insertOne', userId, newAccess({ token: 'tktl5-old-' + cuid() }));
      const stale = await rawAccess(userId, a.id);
      const current = 'tktl5-new-' + cuid();
      await rawWrite(userId, a.id, { token: current, tokenHash: stale.tokenHash, tokenEnc: stale.tokenEnc });
      try {
        await tokensAtRest().unprotectTokensAtRest();
        const raw = await rawAccess(userId, a.id);
        assert.strictEqual(raw.token, current);
        assert.strictEqual(raw.tokenHash, null);
        assert.strictEqual(raw.tokenEnc, null);
      } finally {
        await tokensAtRest().protectTokensAtRest();
      }
      assert.strictEqual((await call(accesses, 'findOne', userId, { token: current }, null)).id, a.id);
    });

    it('[TKTL6] PostgreSQL: unprotect meeting two live accesses with one token names them (ids only); with one deleted it completes', async function () {
      if (engine !== 'postgresql') this.skip();
      const token = 'tktl6-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      const b = await call(accesses, 'insertOne', userId, newAccess({ token: 'tktl6-b-' + cuid() }));
      // b in clear with a's token: what the conversion leaves (see [TKMG7])
      await rawWrite(userId, b.id, { token, tokenHash: null, tokenEnc: null });
      try {
        await assert.rejects(tokensAtRest().unprotectTokensAtRest(), (err) => {
          assert.match(err.message, /share a token/);
          assert.ok(err.message.includes(a.id) && err.message.includes(b.id), err.message);
          assert.ok(!err.message.includes(token), 'the message does not carry the token');
          return true;
        });
        await call(accesses, 'removeOne', userId, { id: b.id });
        await tokensAtRest().unprotectTokensAtRest();
        const idx = await storages.databasePG.query('SELECT 1 FROM pg_indexes WHERE indexname = \'idx_access_token\'');
        assert.strictEqual(idx.rows.length, 1);
      } finally {
        await call(accesses, 'removeOne', userId, { id: b.id });
        await tokensAtRest().protectTokensAtRest();
      }
      assert.strictEqual((await call(accesses, 'findOne', userId, { token }, null)).id, a.id);
    });

    it('[TKTL7] PostgreSQL: rekey meeting a token already held under the configured key names the access', async function () {
      if (engine !== 'postgresql') this.skip();
      const previous = createTokenProtection('tktl7-previous-' + cuid());
      const token = 'tktl7-' + cuid();
      const a = await call(accesses, 'insertOne', userId, newAccess({ token }));
      const prevHash = previous.hashAccessToken(userId, token);
      await rawWrite(userId, a.id, { token: null, tokenHash: prevHash, tokenEnc: previous.sealAccessToken(userId, prevHash, token) });
      // created while the core refused to start: same token, under the configured key
      const b = await call(accesses, 'insertOne', userId, newAccess({ token }));
      try {
        await assert.rejects(tokensAtRest().rekeyTokensAtRest([previous]), (err) => {
          assert.match(err.message, /rekey stopped at access/);
          assert.ok(err.message.includes(a.id), err.message);
          assert.ok(!err.message.includes(token), 'the message does not carry the token');
          return true;
        });
      } finally {
        await call(accesses, 'removeOne', userId, { id: b.id });
        await tokensAtRest().rekeyTokensAtRest([previous]);
      }
      assert.strictEqual((await call(accesses, 'findOne', userId, { token }, null)).id, a.id);
    });
  });

  describe('[TKSQ] SQLite marker of another key', () => {
    it('[TKSQ1] a walk marker under another key id refuses the start', async function () {
      if (engine !== 'sqlite') this.skip();
      const mod = require('storages/engines/sqlite/src/user/AccessesSQLite.ts');
      const marker = path.join(require('storage').userLocalDirectory.getBasePath(), mod.TOKEN_PROTECTED_MARKER);
      const saved = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
      try {
        mod.writeTokenMarker('00000000');
        await assert.rejects(storages.getTokensAtRest().probeTokensAtRest(), (err) => err.name === 'ForeignTokenKeyError');
        await assert.rejects(storages.getTokensAtRest().protectTokensAtRest(), (err) => err.name === 'ForeignTokenKeyError');
      } finally {
        if (saved != null) fs.writeFileSync(marker, saved); else fs.rmSync(marker, { force: true });
      }
    });

    it('[TKSQ2] two handles on one user database convert it once: the second finds nothing to do, the rows stay consistent', async function () {
      if (engine !== 'sqlite') this.skip();
      const { UserBaseStorageDb } = require('storages/engines/sqlite/src/userBaseStorage/UserBaseStorageDb.ts');
      const userId = await indexedUserId();
      try {
        const items = [];
        for (let i = 0; i < 3; i++) items.push(await call(accesses, 'insertOne', userId, newAccess({ token: 'tksq2-' + i + '-' + cuid() })));
        for (const it of items) await rawWrite(userId, it.id, { token: it.token, tokenHash: null, tokenEnc: null });
        const h1 = await UserBaseStorageDb.forUser(userId);
        // a second connection, as another process holds
        const h2 = new UserBaseStorageDb(UserBaseStorageDb.existingPathForUser(userId));
        h2.userId = userId;
        await h2.init();
        try {
          assert.strictEqual(await accesses.protectClearRowsOfUser(h1), items.length);
          assert.strictEqual(await accesses.protectClearRowsOfUser(h2), 0);
        } finally {
          h2.close();
        }
        for (const it of items) {
          const raw = await rawAccess(userId, it.id);
          assert.strictEqual(raw.token, null);
          assert.strictEqual(accesses.tokenProtection.openAccessToken(userId, raw.tokenHash, raw.tokenEnc), it.token);
          assert.strictEqual((await call(accesses, 'findOne', userId, { token: it.token }, null)).id, it.id);
        }
      } finally {
        await call(accesses, 'removeAll', userId);
      }
    });

    it('[TKSQ3] a legacy token stored as a number is converted as its string form', async function () {
      if (engine !== 'sqlite') this.skip();
      const userId = await indexedUserId();
      try {
        const a = await call(accesses, 'insertOne', userId, newAccess({ token: 'tksq3-' + cuid() }));
        const udb = await sqliteUserDb(userId);
        const d = JSON.parse(udb.db.prepare('SELECT data FROM accesses WHERE id = ?').get(a.id).data);
        delete d.tokenHash; delete d.tokenEnc;
        d.token = 1234567;
        udb.db.prepare('UPDATE accesses SET data = ? WHERE id = ?').run(JSON.stringify(d), a.id);
        assert.strictEqual(await accesses.protectClearRowsOfUser(udb), 1);
        const raw = await rawAccess(userId, a.id);
        assert.strictEqual(raw.token, null);
        assert.strictEqual(accesses.tokenProtection.openAccessToken(userId, raw.tokenHash, raw.tokenEnc), '1234567');
      } finally {
        await call(accesses, 'removeAll', userId);
      }
    });
  });
});
