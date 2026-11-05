/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');

/**
 * [PGIX] the PostgreSQL platform engine's `init()` creates the byte-order key
 * index with `CREATE INDEX IF NOT EXISTS`, which is not atomic across
 * sessions: a process booting while another creates it may get
 * `duplicate_table` (42P07). That answer means the index exists: `init()`
 * succeeds; any other failure still fails it. Over a stand-in database (no
 * server needed).
 */
describe('[PGIX] PostgreSQL platform engine: the key index created by a concurrent boot', function () {
  const { _internals } = require('../src/_internals.ts');
  const { DBpostgresql } = require('../src/DBpostgresql.ts');
  let saved;

  before(function () { saved = _internals.databasePG; });
  after(function () { _internals.set('databasePG', saved); });

  /** A database whose index statement fails with `error` (null: succeeds); the statements run are recorded. */
  function databaseFailingIndexWith (error) {
    const statements = [];
    return {
      statements,
      async ensureConnect () {},
      async query (text) {
        statements.push(text);
        if (error != null && /CREATE INDEX/.test(text)) throw error;
        return { rows: [] };
      }
    };
  }

  it('[PGIX1] a duplicate_table (42P07) answer to the index creation is success', async function () {
    const db = databaseFailingIndexWith(Object.assign(new Error('relation "platform_kv_key_c" already exists'), { code: '42P07' }));
    _internals.set('databasePG', db);
    await new DBpostgresql().init();
    assert.ok(db.statements.some((s) => /CREATE INDEX IF NOT EXISTS platform_kv_key_c/.test(s)), JSON.stringify(db.statements));
  });

  it('[PGIX2] any other failure of the index creation fails init()', async function () {
    _internals.set('databasePG', databaseFailingIndexWith(Object.assign(new Error('permission denied'), { code: '42501' })));
    await assert.rejects(() => new DBpostgresql().init(), /permission denied/);
  });
});
