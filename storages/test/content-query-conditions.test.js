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

const {
  validateAndNormalizeConditions, matchesConditions, MAX_CONDITIONS, MAX_VALUES_PER_IN
} = require('../shared/contentQueryConditions.ts');
const { jsonConditionToSql } = require('../engines/sqlite/src/userSQLite/UserDatabase.ts');
const { convertJsonCondition } = require('../engines/postgresql/src/dataStore/localUserEventsPG.ts');

describe('[CQRY] Content-query conditions', () => {
  describe('[CQVL] validation + normalization', () => {
    it('[VL01] accepts every operator and normalizes paths', () => {
      const conditions = validateAndNormalizeConditions([
        { path: 'drug.codes.atc', eq: 'G03DA04' },
        { path: 'taken', neq: false },
        { path: 'drug.codes.atc', in: ['A', 'B'] },
        { path: 'related.ck123', exists: true },
        { path: 'scope', gte: 2 },
        { path: 'scope', lt: 5 },
        { path: 'drug.codes.atc', prefix: 'G03' },
        { path: '$', gt: 12 }
      ], 'content');
      assert.strictEqual(conditions.length, 8);
      assert.deepStrictEqual(conditions[0], { field: 'content', path: ['drug', 'codes', 'atc'], op: 'eq', value: 'G03DA04' });
      assert.strictEqual(conditions[7].path, null); // root $
    });

    it('[VL02] accepts colon-namespaced segments', () => {
      const [c] = validateAndNormalizeConditions([{ path: 'ehr-sync:v2.externalId', eq: 'x' }], 'clientData');
      assert.deepStrictEqual(c.path, ['ehr-sync:v2', 'externalId']);
    });

    it('[VL03] rejects malformed paths', () => {
      for (const path of ['drug..codes', '.a', 'a.', 'a[0]', 'a b', '$.a', '', 'é']) {
        assert.throws(() => validateAndNormalizeConditions([{ path, eq: 1 }], 'content'), /Invalid 'content' parameter/, `path '${path}' should be rejected`);
      }
    });

    it('[VL04] rejects eq null, two operators, no operator, unknown properties', () => {
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', eq: null }], 'content'), /null is not allowed/);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', eq: 1, lt: 2 }], 'content'), /exactly one operator/);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a' }], 'content'), /exactly one operator/);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', eq: 1, foo: 2 }], 'content'), /unknown property/);
    });

    it('[VL05] rejects bad operator value types', () => {
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', gt: 'x' }], 'content'), /finite number/);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', exists: 'yes' }], 'content'), /boolean/);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', prefix: '' }], 'content'), /non-empty string/);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', in: [] }], 'content'), /non-empty array/);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', in: [1, null] }], 'content'), /null is not allowed/);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', eq: { o: 1 } }], 'content'), /string, number or boolean/);
    });

    it('[VL06] enforces limits', () => {
      const many = Array.from({ length: MAX_CONDITIONS + 1 }, () => ({ path: 'a', eq: 1 }));
      assert.throws(() => validateAndNormalizeConditions(many, 'content'), /at most/);
      const values = Array.from({ length: MAX_VALUES_PER_IN + 1 }, (_, i) => i);
      assert.throws(() => validateAndNormalizeConditions([{ path: 'a', in: values }], 'content'), /at most/);
      assert.throws(() => validateAndNormalizeConditions({ path: 'a', eq: 1 }, 'content'), /array of conditions/);
    });
  });

  // Fixture documents covering scalars, nesting, JSON types, tricky strings
  const FIXTURES = [
    { drug: { label: 'Progesterone', codes: { atc: 'G03DA04', snomed: '126109000' } }, taken: true, scope: 2 },
    { drug: { label: 'Aspirin', codes: { atc: 'B01AC06' } }, taken: false },
    { drug: { label: "O'Hara's mix _%", codes: { atc: 'G03DA99' } }, taken: 1, scope: 2.5 },
    { taken: 'true', scope: '2', 'ehr-sync:v2': { externalId: 'obs-78421' } },
    { related: { ckPDF01abc: 'derived-from' }, scope: null },
    14.2,
    'G03DA04',
    true,
    null,
    { scope: 14 },
    { drug: { codes: ['G03DA04'] } },
    undefined // event without the field at all
  ];

  const CONDITION_CATALOGUE = [
    { path: 'drug.codes.atc', eq: 'G03DA04' },
    { path: 'taken', eq: true },
    { path: 'taken', eq: 1 },
    { path: 'taken', eq: 'true' },
    { path: 'taken', neq: true },
    { path: 'scope', eq: 2 },
    { path: 'scope', eq: '2' },
    { path: 'drug.codes.atc', in: ['G03DA04', 'B01AC06'] },
    { path: 'taken', in: [true, 'true'] },
    { path: 'scope', in: [2, 2.5] },
    { path: 'related.ckPDF01abc', exists: true },
    { path: 'scope', exists: true },
    { path: 'scope', exists: false },
    { path: 'drug.codes', exists: true },
    { path: 'scope', gt: 2 },
    { path: 'scope', gte: 2 },
    { path: 'scope', lt: 2.5 },
    { path: 'scope', lte: 14 },
    { path: 'drug.codes.atc', prefix: 'G03DA' },
    { path: 'drug.label', prefix: "O'Hara" },
    { path: 'drug.label', prefix: 'O_' }, // literal underscore — must not act as wildcard
    { path: '$', eq: 'G03DA04' },
    { path: '$', eq: true },
    { path: '$', gte: 12 },
    { path: '$', exists: true },
    { path: '$', exists: false },
    { path: '$', prefix: 'G03' },
    { path: 'ehr-sync:v2.externalId', eq: 'obs-78421' },
    { path: 'drug.codes', eq: 'G03DA04' } // array value — scalar ops must not match
  ];

  describe('[CQMR] reference matcher semantics', () => {
    it('[MR01] strict JSON types: true ≠ 1 ≠ "true", 2 ≠ "2"', () => {
      assert.ok(matchesOne({ taken: true }, { path: 'taken', eq: true }));
      assert.ok(!matchesOne({ taken: 1 }, { path: 'taken', eq: true }));
      assert.ok(!matchesOne({ taken: 'true' }, { path: 'taken', eq: true }));
      assert.ok(!matchesOne({ taken: true }, { path: 'taken', eq: 1 }));
      assert.ok(matchesOne({ scope: 2 }, { path: 'scope', eq: 2 }));
      assert.ok(!matchesOne({ scope: '2' }, { path: 'scope', eq: 2 }));
    });

    it('[MR02] missing path never matches; explicit null is "present"', () => {
      assert.ok(!matchesOne({}, { path: 'a', eq: 1 }));
      assert.ok(!matchesOne({}, { path: 'a', neq: 1 }));
      assert.ok(matchesOne({}, { path: 'a', exists: false }));
      assert.ok(matchesOne({ a: null }, { path: 'a', exists: true }));
      assert.ok(matchesOne({ a: null }, { path: 'a', neq: 1 }));
    });

    it('[MR03] root $ addresses scalar content', () => {
      assert.ok(matchesOne(14.2, { path: '$', gte: 12 }));
      assert.ok(!matchesOne('14.2', { path: '$', gte: 12 }));
      assert.ok(matchesOne('G03DA04', { path: '$', prefix: 'G03' }));
      assert.ok(matchesOne(undefined, { path: '$', exists: false }));
    });

    function matchesOne (content, rawCondition) {
      const [condition] = validateAndNormalizeConditions([rawCondition], 'content');
      return matchesConditions({ content }, [condition]);
    }
  });

  describe('[CQSQ] SQLite SQL conforms to the reference matcher', () => {
    let db;
    before(() => {
      db = new SQLite3(':memory:');
      db.prepare('CREATE TABLE events (rowidx INTEGER, content TEXT, clientData TEXT)').run();
      const insert = db.prepare('INSERT INTO events (rowidx, content, clientData) VALUES (?, ?, ?)');
      FIXTURES.forEach((fixture, i) => {
        const json = fixture === undefined ? null : JSON.stringify(fixture);
        insert.run(i, json, json);
      });
    });
    after(() => { db.close(); });

    for (const [i, rawCondition] of CONDITION_CATALOGUE.entries()) {
      it(`[SQ${String(i).padStart(2, '0')}] ${JSON.stringify(rawCondition)}`, () => {
        for (const field of ['content', 'clientData']) {
          const [condition] = validateAndNormalizeConditions([rawCondition], field);
          const where = jsonConditionToSql(condition);
          const got = db.prepare(`SELECT rowidx FROM events WHERE ${where} ORDER BY rowidx`).all().map((r) => r.rowidx);
          const expected = FIXTURES
            .map((fixture, idx) => ({ fixture, idx }))
            .filter(({ fixture }) => matchesConditions({ [field]: fixture }, [condition]))
            .map(({ idx }) => idx);
          assert.deepStrictEqual(got, expected, `field=${field} WHERE ${where}`);
        }
      });
    }
  });

  describe('[CQPG] PostgreSQL SQL generation', () => {
    it('[PG01] binds every user value as a parameter (no interpolation)', () => {
      for (const rawCondition of CONDITION_CATALOGUE) {
        const [condition] = validateAndNormalizeConditions([rawCondition], 'content');
        const params = [];
        const { condition: sql, nextIdx } = convertJsonCondition(condition, 1, params);
        assert.strictEqual(nextIdx, 1 + params.length, `idx bookkeeping for ${sql}`);
        // no raw user strings may leak into the SQL text
        if (typeof rawCondition.eq === 'string' && rawCondition.eq.length > 3) {
          assert.ok(!sql.includes(rawCondition.eq), `value interpolated in: ${sql}`);
        }
      }
    });

    it('[PG02] uses jsonb-domain comparison with type guards', () => {
      const [condition] = validateAndNormalizeConditions([{ path: 'scope', gte: 2 }], 'content');
      const params = [];
      const { condition: sql } = convertJsonCondition(condition, 1, params);
      assert.match(sql, /jsonb_typeof\(e\.content #> \$1::text\[\]\) = 'number'/);
      assert.match(sql, />= to_jsonb\(\$2::numeric\)/);
      assert.deepStrictEqual(params, [['scope'], 2]);
    });

    it('[PG03] clientData maps to the client_data column and $ to the root', () => {
      const [condition] = validateAndNormalizeConditions([{ path: '$', eq: 'x' }], 'clientData');
      const params = [];
      const { condition: sql } = convertJsonCondition(condition, 1, params);
      assert.match(sql, /e\.client_data = to_jsonb\(\$1::text\)/);
      assert.deepStrictEqual(params, ['x']);
    });
  });
});
