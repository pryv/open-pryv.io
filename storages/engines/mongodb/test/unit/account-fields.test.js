/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const cuid = require('cuid');

describe('[ACFM] Account fields (MongoDB)', () => {
  let userAccountStorage;
  const userId = cuid();

  before(async () => {
    const engine = require('storages/engines/mongodb/src/index');
    const helpers = require('../../../../test/helpers');
    const manifest = require('../../manifest.json');
    const config = helpers.getEngineConfig('mongodb', manifest);
    const internals = helpers.getInternals(manifest);
    await engine.init(config, helpers.getLogger, internals);
    userAccountStorage = engine.getUserAccountStorage();
    await userAccountStorage.init();
  });

  afterEach(async () => {
    await userAccountStorage._clearAll(userId);
  });

  describe('[AF01] setAccountField / getAccountField', () => {
    it('[AF1A] stores and retrieves a field value', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'test@example.com', 'access-1');
      const value = await userAccountStorage.getAccountField(userId, 'email');
      assert.strictEqual(value, 'test@example.com');
    });

    it('[AF1B] returns null for non-existent field', async () => {
      const value = await userAccountStorage.getAccountField(userId, 'nonexistent');
      assert.strictEqual(value, null);
    });

    it('[AF1C] latest set wins (overwrites previous)', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'old@example.com', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'email', 'new@example.com', 'access-2', 2000);
      const value = await userAccountStorage.getAccountField(userId, 'email');
      assert.strictEqual(value, 'new@example.com');
    });

    it('[AF1D] returns the record with field, value, time, createdBy', async () => {
      const result = await userAccountStorage.setAccountField(userId, 'language', 'fr', 'access-1', 1500);
      assert.strictEqual(result.field, 'language');
      assert.strictEqual(result.value, 'fr');
      assert.strictEqual(result.time, 1500);
      assert.strictEqual(result.createdBy, 'access-1');
    });
  });

  describe('[AF02] getAccountFields', () => {
    it('[AF2A] returns all current fields as a map', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'a@b.com', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'language', 'en', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'phone', '+41000', 'access-1', 1000);

      const fields = await userAccountStorage.getAccountFields(userId);
      assert.strictEqual(fields.email, 'a@b.com');
      assert.strictEqual(fields.language, 'en');
      assert.strictEqual(fields.phone, '+41000');
    });

    it('[AF2B] returns only the latest value per field', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'old@b.com', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'email', 'new@b.com', 'access-2', 2000);
      await userAccountStorage.setAccountField(userId, 'language', 'en', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'language', 'fr', 'access-2', 2000);

      const fields = await userAccountStorage.getAccountFields(userId);
      assert.strictEqual(fields.email, 'new@b.com');
      assert.strictEqual(fields.language, 'fr');
      assert.strictEqual(Object.keys(fields).length, 2);
    });

    it('[AF2C] returns empty object for user with no fields', async () => {
      const fields = await userAccountStorage.getAccountFields(userId);
      assert.deepStrictEqual(fields, {});
    });
  });

  describe('[AF03] getAccountFieldHistory', () => {
    it('[AF3A] returns history in reverse chronological order', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'first@b.com', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'email', 'second@b.com', 'access-2', 2000);
      await userAccountStorage.setAccountField(userId, 'email', 'third@b.com', 'access-3', 3000);

      const history = await userAccountStorage.getAccountFieldHistory(userId, 'email');
      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[0].value, 'third@b.com');
      assert.strictEqual(history[0].time, 3000);
      assert.strictEqual(history[0].createdBy, 'access-3');
      assert.strictEqual(history[1].value, 'second@b.com');
      assert.strictEqual(history[2].value, 'first@b.com');
    });

    it('[AF3B] respects limit parameter', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'a@b.com', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'email', 'b@b.com', 'access-2', 2000);
      await userAccountStorage.setAccountField(userId, 'email', 'c@b.com', 'access-3', 3000);

      const history = await userAccountStorage.getAccountFieldHistory(userId, 'email', 2);
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].value, 'c@b.com');
      assert.strictEqual(history[1].value, 'b@b.com');
    });

    it('[AF3C] returns empty array for non-existent field', async () => {
      const history = await userAccountStorage.getAccountFieldHistory(userId, 'nonexistent');
      assert.deepStrictEqual(history, []);
    });
  });

  describe('[AF04] deleteAccountField', () => {
    it('[AF4A] removes all history for a field', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'a@b.com', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'email', 'b@b.com', 'access-2', 2000);
      await userAccountStorage.deleteAccountField(userId, 'email');

      const value = await userAccountStorage.getAccountField(userId, 'email');
      assert.strictEqual(value, null);
      const history = await userAccountStorage.getAccountFieldHistory(userId, 'email');
      assert.strictEqual(history.length, 0);
    });

    it('[AF4B] does not affect other fields', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'a@b.com', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'language', 'en', 'access-1', 1000);
      await userAccountStorage.deleteAccountField(userId, 'email');

      const value = await userAccountStorage.getAccountField(userId, 'language');
      assert.strictEqual(value, 'en');
    });
  });

  describe('[AF05] export/import/clear', () => {
    it('[AF5A] exports and imports account fields', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'a@b.com', 'access-1', 1000);
      await userAccountStorage.setAccountField(userId, 'language', 'en', 'access-1', 1000);

      const exported = await userAccountStorage._exportAll(userId);
      assert.ok(exported.accountFields);
      assert.strictEqual(exported.accountFields.length, 2);

      await userAccountStorage._clearAll(userId);
      assert.deepStrictEqual(await userAccountStorage.getAccountFields(userId), {});

      await userAccountStorage._importAll(userId, exported);
      const fields = await userAccountStorage.getAccountFields(userId);
      assert.strictEqual(fields.email, 'a@b.com');
      assert.strictEqual(fields.language, 'en');
    });

    it('[AF5B] clearAll removes account fields', async () => {
      await userAccountStorage.setAccountField(userId, 'email', 'a@b.com', 'access-1', 1000);
      await userAccountStorage._clearAll(userId);
      assert.deepStrictEqual(await userAccountStorage.getAccountFields(userId), {});
    });
  });
});
