/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * UsersLocalIndexDB conformance test suite.
 * @param {Function} getDB - async function returning an initialized UsersLocalIndexDB instance
 */
module.exports = function conformanceTests (getDB) {
  const assert = require('node:assert');
  const cuid = require('cuid');

  describe('UsersLocalIndexDB conformance', () => {
    let db;

    before(async () => {
      db = await getDB();
    });

    afterEach(async () => {
      await db.deleteAll();
    });

    describe('addUser() / getIdForName() / getNameForId()', () => {
      it('must add a user and retrieve by name or id', async () => {
        const username = 'user-' + cuid();
        const userId = cuid();
        await db.addUser(username, userId);

        const retrievedId = await db.getIdForName(username);
        assert.strictEqual(retrievedId, userId);

        const retrievedName = await db.getNameForId(userId);
        assert.strictEqual(retrievedName, username);
      });

      it('must return undefined for unknown username', async () => {
        const result = await db.getIdForName('unknown-' + cuid());
        assert.strictEqual(result, undefined);
      });

      it('must return undefined for unknown userId', async () => {
        const result = await db.getNameForId(cuid());
        assert.strictEqual(result, undefined);
      });
    });

    describe('getAllByUsername()', () => {
      it('must return all users as username->userId map', async () => {
        const u1 = 'user1-' + cuid();
        const id1 = cuid();
        const u2 = 'user2-' + cuid();
        const id2 = cuid();
        await db.addUser(u1, id1);
        await db.addUser(u2, id2);

        const all = await db.getAllByUsername();
        assert.strictEqual(all[u1], id1);
        assert.strictEqual(all[u2], id2);
      });
    });

    describe('deleteById()', () => {
      it('must delete a user by userId', async () => {
        const username = 'del-' + cuid();
        const userId = cuid();
        await db.addUser(username, userId);

        await db.deleteById(userId);
        const result = await db.getIdForName(username);
        assert.strictEqual(result, undefined);
      });
    });

    describe('deleteAll()', () => {
      it('must delete all entries', async () => {
        await db.addUser('a-' + cuid(), cuid());
        await db.addUser('b-' + cuid(), cuid());
        await db.deleteAll();

        const all = await db.getAllByUsername();
        assert.deepStrictEqual(all, {});
      });
    });

    describe('migration methods', () => {
      it('exportAll() must return same data as getAllByUsername()', async () => {
        const u = 'exp-' + cuid();
        const id = cuid();
        await db.addUser(u, id);

        const exported = await db.exportAll();
        assert.strictEqual(exported[u], id);
      });

      it('importAll() must import data', async () => {
        const u = 'imp-' + cuid();
        const id = cuid();
        await db.importAll({ [u]: id });

        const result = await db.getIdForName(u);
        assert.strictEqual(result, id);
      });

      it('clearAll() must remove all data', async () => {
        await db.addUser('clr-' + cuid(), cuid());
        await db.clearAll();

        const all = await db.getAllByUsername();
        assert.deepStrictEqual(all, {});
      });
    });
  });
};
