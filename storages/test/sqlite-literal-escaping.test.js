/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const SQLite3 = require('better-sqlite3');

const { coerceValueForColumn } = require('../engines/sqlite/src/userSQLite/schema/events.ts');

describe('[SQLE] SQLite text-literal escaping', () => {
  let db;
  before(() => { db = new SQLite3(':memory:'); });
  after(() => { db.close(); });

  function roundTrip (literal) {
    return db.prepare(`SELECT ${literal} AS v`).get().v;
  }

  it("[QE01] doubles single quotes ('' not \\')", () => {
    assert.strictEqual(coerceValueForColumn('description', "don't"), "'don''t'");
  });

  it('[QE02] quote-containing values round-trip through SQLite unchanged', () => {
    for (const value of ["don't", "it's '' tricky", "\\' OR '1'='1", "trailing'", "'leading"]) {
      assert.strictEqual(roundTrip(coerceValueForColumn('type', value)), value);
    }
  });

  it('[QE03] backslashes are preserved verbatim (not an escape character)', () => {
    assert.strictEqual(roundTrip(coerceValueForColumn('content', 'a\\nb\\')), 'a\\nb\\');
  });
});
