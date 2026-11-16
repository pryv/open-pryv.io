/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { getConfig } = require('@pryv/boiler');
const { parseDatabaseUrl, fieldsToFill, applyDatabaseUrl } = require('../src/databaseUrl.ts');

// A config double with boiler's scope lookup: `scopes` maps a field to the
// scope its effective value comes from.
function fakeConfig (scopes) {
  const written = {};
  return {
    written,
    getScopeAndValue (key) {
      const field = key.split(':').pop();
      return scopes[field] ? { scope: scopes[field], value: 'x', info: '' } : null;
    },
    set (key, value) { written[key.split(':').pop()] = value; }
  };
}

describe('[PGDU] DATABASE_URL fallback for the PostgreSQL connection', function () {
  it('[PGDU1] parses every field, decoding user, password and database', function () {
    assert.deepStrictEqual(
      parseDatabaseUrl('postgres://us%40er:p%3Ass%2Fw@db.example.com:6543/my%20db?sslmode=require'),
      { host: 'db.example.com', port: 6543, database: 'my db', user: 'us@er', password: 'p:ss/w' }
    );
  });

  it('[PGDU2] accepts postgresql://, an IPv6 host, and leaves out the fields the URL does not carry', function () {
    assert.deepStrictEqual(parseDatabaseUrl('postgresql://[::1]/pryv'), { host: '::1', database: 'pryv' });
  });

  it('[PGDU3] refuses an unparsable URL or another scheme, without echoing the URL', function () {
    assert.throws(() => parseDatabaseUrl('not a url secret-pw'), (err) => {
      assert.match(err.message, /not a valid URL/);
      assert.doesNotMatch(err.message, /secret-pw/);
      return true;
    });
    assert.throws(() => parseDatabaseUrl('mysql://u:secret-pw@h/d'), (err) => {
      assert.match(err.message, /expected postgres or postgresql/);
      assert.doesNotMatch(err.message, /secret-pw/);
      return true;
    });
  });

  it('[PGDU4] fills only the fields still at their default-config value (or unset)', function () {
    const values = parseDatabaseUrl('postgres://u:pw@h:1/d');
    const scopes = { host: 'default-file', port: 'override-file', database: 'env', user: 'default-file' };
    assert.deepStrictEqual(fieldsToFill(values, (f) => scopes[f] ?? null), ['host', 'user', 'password']);
  });

  it('[PGDU5] applies the URL in place and returns the field names taken from it', function () {
    const config = fakeConfig({ host: 'default-file', port: 'default-file', database: 'default-file', user: 'test', password: 'default-file' });
    const fields = applyDatabaseUrl(config, { DATABASE_URL: 'postgres://u:pw@h:7/d' });
    assert.deepStrictEqual(fields, ['host', 'port', 'database', 'password']);
    assert.deepStrictEqual(config.written, { host: 'h', port: 7, database: 'd', password: 'pw' });
  });

  it('[PGDU6] does nothing when DATABASE_URL is unset or empty', function () {
    const config = fakeConfig({ host: 'default-file' });
    assert.deepStrictEqual(applyDatabaseUrl(config, {}), []);
    assert.deepStrictEqual(applyDatabaseUrl(config, { DATABASE_URL: '' }), []);
    assert.deepStrictEqual(config.written, {});
  });

  it('[PGDU7] with the real config, values set by a config file other than the default one win', async function () {
    const config = await getConfig();
    // The test config file sets every connection field.
    assert.notStrictEqual(config.getScopeAndValue('storages:engines:postgresql:database').scope, 'default-file');
    const before = config.get('storages:engines:postgresql');
    assert.deepStrictEqual(applyDatabaseUrl(config, { DATABASE_URL: 'postgres://u:pw@elsewhere:1/other' }), []);
    assert.deepStrictEqual(config.get('storages:engines:postgresql'), before);
  });
});
