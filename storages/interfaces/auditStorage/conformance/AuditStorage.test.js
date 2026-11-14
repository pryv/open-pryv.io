/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * AuditStorage + UserAuditDatabase conformance test suite.
 * Tests the LRU-cached Storage manager and the per-user Database contract.
 *
 * @param {Function} getStorage - async function returning an initialized Storage instance
 * @param {Function} getUserId - function returning a unique userId for test isolation
 * @param {Function} cleanupFn - async function called after tests for cleanup (receives userId)
 * @param {Object} [engineHooks] - engine test hooks, all optional:
 *   `setSummaryChunkRows(rows)` sets the window size of a windowed `summarize`
 *   and returns the previous one
 */
export default function conformanceTests (getStorage, getUserId, cleanupFn, engineHooks = {}) {
  const assert = require('node:assert');
  const { validateAuditStorage } = require('../AuditStorage.ts');
  const { validateUserAuditDatabase } = require('../UserAuditDatabase.ts');

  describe('AuditStorage conformance', () => {
    let storage;
    let userId;
    let userDb;

    before(async () => {
      storage = await getStorage();
      userId = getUserId();
      userDb = await storage.forUser(userId);
    });

    after(async () => {
      if (cleanupFn) await cleanupFn(userId);
    });

    it('[SQ01] must pass validateAuditStorage', () => {
      validateAuditStorage(storage);
    });

    it('[SQ02] getVersion() must return a version string', () => {
      const version = storage.getVersion();
      assert.ok(typeof version === 'string');
      assert.ok(version.length > 0);
    });

    it('[SQ03] forUser() must return a UserDatabase instance', async () => {
      assert.ok(userDb);
      assert.strictEqual(typeof userDb.getEvents, 'function');
    });

    it('[SQ04] forUser() must return the same cached instance', async () => {
      const userDb2 = await storage.forUser(userId);
      assert.strictEqual(userDb, userDb2);
    });

    describe('UserAuditDatabase conformance', () => {
      it('[SQ05] must pass validateUserAuditDatabase', () => {
        validateUserAuditDatabase(userDb);
      });

      it('[SQ06] countEvents() must return 0 initially', async () => {
        const count = await userDb.countEvents();
        assert.strictEqual(count, 0);
      });

      const testEvent = {
        id: 'sq-test-event-1',
        streamIds: ['sq-stream-1'],
        type: 'test/test',
        time: 1000,
        created: 1000,
        createdBy: 'test',
        modified: 1000,
        modifiedBy: 'test'
      };

      it('[SQ07] createEvent() must insert an event', async () => {
        await userDb.createEvent(testEvent);
        const count = await userDb.countEvents();
        assert.strictEqual(count, 1);
      });

      it('[SQ08] getOneEvent() must return the inserted event', async () => {
        const event = await userDb.getOneEvent('sq-test-event-1');
        assert.ok(event);
        assert.strictEqual(event.id, 'sq-test-event-1');
        assert.strictEqual(event.type, 'test/test');
      });

      it('[SQ09] getEvents() must return matching events', async () => {
        const events = await userDb.getEvents({
          query: [
            { type: 'equal', content: { field: 'type', value: 'test/test' } }
          ]
        });
        assert.ok(Array.isArray(events));
        assert.ok(events.length >= 1);
      });

      it('[SQ10] updateEvent() must update the event', async () => {
        const updated = await userDb.updateEvent('sq-test-event-1', {
          type: 'test/updated',
          modified: 2000,
          modifiedBy: 'test-update'
        });
        assert.ok(updated);
        const event = await userDb.getOneEvent('sq-test-event-1');
        assert.strictEqual(event.type, 'test/updated');
      });

      it('[SQ11] getAllActions() must return an array', async () => {
        const actions = await userDb.getAllActions();
        assert.ok(Array.isArray(actions));
      });

      it('[SQ12] getAllAccesses() must return an array', async () => {
        const accesses = await userDb.getAllAccesses();
        assert.ok(Array.isArray(accesses));
      });

      it('[SQ17] createEvent()/getOneEvent() must round-trip breach-scope content fields', async () => {
        // The breach-scope read enrichment rides inside the `content` JSON blob
        // (TEXT on SQLite, JSONB on PG). Assert both engines preserve the shape,
        // including a re-prefixed non-local stream id and the incomplete flag.
        const contentEvent = {
          id: 'sq-breach-scope-1',
          streamIds: ['sq-stream-1'],
          type: 'test/test',
          time: 3000,
          created: 3000,
          createdBy: 'test',
          modified: 3000,
          modifiedBy: 'test',
          content: {
            action: 'events.get',
            recordCount: 42,
            recordCountIncomplete: true,
            scopedStreamIds: ['yo', ':_audit:access-xyz'],
            scopedStreamCount: 2
          }
        };
        await userDb.createEvent(contentEvent);
        const event = await userDb.getOneEvent('sq-breach-scope-1');
        assert.ok(event);
        assert.ok(event.content, 'content persisted');
        assert.strictEqual(event.content.recordCount, 42);
        assert.strictEqual(event.content.recordCountIncomplete, true);
        assert.deepEqual(event.content.scopedStreamIds, ['yo', ':_audit:access-xyz']);
        assert.strictEqual(event.content.scopedStreamCount, 2);
      });

      describe('migration methods', () => {
        it('[SQ13] exportAllEvents() must return all raw rows', async () => {
          const rows = await userDb.exportAllEvents();
          assert.ok(Array.isArray(rows));
          assert.ok(rows.length >= 1);
          // Raw rows use 'eventid' not 'id'
          assert.ok(rows[0].eventid != null);
        });

        it('[SQ14] importAllEvents() must insert raw rows', async () => {
          const rows = await userDb.exportAllEvents();
          // Modify eventid to avoid UNIQUE constraint
          const importRow = Object.assign({}, rows[0], { eventid: 'sq-imported-1' });
          await userDb.importAllEvents([importRow]);
          const count = await userDb.countEvents();
          assert.ok(count >= 2);
        });

        it('[SQ15] importAllEvents() with empty array must be a no-op', async () => {
          const countBefore = await userDb.countEvents();
          await userDb.importAllEvents([]);
          const countAfter = await userDb.countEvents();
          assert.strictEqual(countAfter, countBefore);
        });

        it('[SQ18] exportAllEventsStreamed() (when present) must yield the same raw rows as exportAllEvents()', async function () {
          if (typeof userDb.exportAllEventsStreamed !== 'function') return this.skip();
          const arrayRows = await userDb.exportAllEvents();
          const streamedRows = [];
          for await (const row of userDb.exportAllEventsStreamed()) streamedRows.push(row);
          // Both run the same SELECT with no ORDER BY, so compare as sets keyed
          // by eventid: an incidental scan-order difference is not a defect and
          // must not flake this.
          const byEventid = (a, b) => String(a.eventid).localeCompare(String(b.eventid));
          assert.deepStrictEqual([...streamedRows].sort(byEventid), [...arrayRows].sort(byEventid));
        });

        it('[SQ19] exportAllEventsStreamed() (when present) on an empty store must yield nothing', async function () {
          const emptyDb = await storage.forUser(getUserId() + '-empty-streamed');
          if (typeof emptyDb.exportAllEventsStreamed !== 'function') return this.skip();
          const rows = [];
          for await (const row of emptyDb.exportAllEventsStreamed()) rows.push(row);
          assert.strictEqual(rows.length, 0);
        });
      });

      describe('summarize()', () => {
        const { SUMMARY_BUDGET_ERROR_CODE } = require('../UserAuditDatabase.ts');
        const H = 3600;
        const OK = 'audit-log/pryv-api';
        const ERR = 'audit-log/pryv-api-error';
        // [id, time, action (undefined: none), type, access streams, extra fields]
        const rowsA = [
          ['s-r0', 36000, 'events.get', OK, ['access-c']],
          ['s-r1', 36005, 'events.get', OK, ['access-a']],
          ['s-r2', 36100, 'events.get', OK, ['access-a']],
          ['s-r3', 36200, 'events.get', ERR, ['access-b']],
          ['s-r8', 36300, undefined, OK, ['access-c']],
          ['s-r9', 36050, 'events.get', OK, ['access-a', 'access-h'], { headId: 's-r2' }],
          ['s-r10', 36060, 'events.get', OK, ['access-a', 'access-h'], { deleted: 36061 }],
          ['s-r4', 39600, 'events.create', OK, ['access-b']],
          ['s-t1', 39600, 'events.create', OK, ['access-b']],
          ['s-t2', 39600, 'events.create', ERR, ['access-b']],
          ['s-r11', 39601, 'events.get', OK, ['access-x_y']],
          ['s-r12', 39602, 'accesses.get', OK, ['access-xzy']],
          ['s-r13', 39603, 'events.get', OK, ['access-p%q']],
          ['s-r5', 43199.5, 'events.create', OK, ['access-a', 'access-a:2']],
          ['s-r6', 43200, 'events.get', OK, ['access-a']],
          ['s-r7', 35999, 'events.get', OK, ['access-a']]
        ];
        const rowsB = [
          ['s-b1', 36010, 'events.get', OK, ['access-a', 'access-b2']],
          ['s-b2', 36020, 'events.get', OK, ['access-b2']]
        ];
        const ALL_A = [
          '10|events.get|false|3', '10|events.get|true|1', '10|null|false|1',
          '11|accesses.get|false|1', '11|events.create|false|3', '11|events.create|true|1', '11|events.get|false|2',
          '12|events.get|false|1'
        ];
        const ACCESS_A = ['10|events.get|false|2', '11|events.create|false|1', '12|events.get|false|1'];

        let dbA, dbB;
        const userA = () => userId + '-sum';
        const userB = () => userId + '-sum2';

        async function insert (db, rows) {
          for (const [id, time, action, type, accessIds, extra] of rows) {
            const content = action === undefined ? {} : { action };
            const actionIds = action === undefined ? [] : ['action-' + action];
            await db.createEvent(Object.assign({
              id,
              streamIds: accessIds.concat(actionIds),
              type,
              time,
              content,
              created: time,
              createdBy: 'test',
              modified: time,
              modifiedBy: 'test'
            }, extra || {}));
          }
        }

        /** Groups as sorted `slot|action|error|count` strings. */
        function norm (groups) {
          assert.ok(Array.isArray(groups));
          return groups.map((g) => `${g.slot}|${g.action}|${g.error}|${g.count}`).sort();
        }

        async function summary (db, params) {
          return norm(await db.summarize(Object.assign({ fromTime: 10 * H, toTime: 13 * H, slotSeconds: H }, params)));
        }

        before(async () => {
          dbA = await storage.forUser(userA());
          dbB = await storage.forUser(userB());
          await insert(dbA, rowsA);
          await insert(dbB, rowsB);
        });

        after(async () => {
          await storage.deleteUser(userA());
          await storage.deleteUser(userB());
        });

        it('[ASQ1] must count head rows grouped by slot, action and outcome', async () => {
          assert.deepStrictEqual(await summary(dbA, {}), ALL_A);
          for (const g of await dbA.summarize({ fromTime: 10 * H, toTime: 13 * H, slotSeconds: H })) {
            assert.strictEqual(typeof g.slot, 'number');
            assert.strictEqual(typeof g.count, 'number');
            assert.strictEqual(typeof g.error, 'boolean');
            assert.ok(g.action === null || typeof g.action === 'string');
          }
          // Quarter-hour slots: 36000..36300 all fall in slot 40.
          assert.deepStrictEqual(await summary(dbA, { slotSeconds: 900, toTime: 36900 }),
            ['40|events.get|false|3', '40|events.get|true|1', '40|null|false|1']);
        });

        it('[ASQ2] must count the half-open range [fromTime, toTime)', async () => {
          assert.deepStrictEqual(await summary(dbA, { toTime: 12 * H }), ALL_A.filter((g) => !g.startsWith('12|')));
          assert.deepStrictEqual(await summary(dbA, { fromTime: 10 * H + 0.5, toTime: 11 * H }),
            ['10|events.get|false|2', '10|events.get|true|1', '10|null|false|1']);
          assert.deepStrictEqual(await summary(dbA, { fromTime: 12 * H, toTime: 12 * H }), []);
        });

        it('[ASQ3] must filter on access streams, matching ids literally', async () => {
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-a'] }), ACCESS_A);
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-a:2'] }), ['11|events.create|false|1']);
          // A row carrying two of the given ids counts once.
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-a', 'access-a:2'] }), ACCESS_A);
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-a', 'access-b'] }), [
            '10|events.get|false|2', '10|events.get|true|1', '11|events.create|false|3', '11|events.create|true|1', '12|events.get|false|1'
          ]);
          // `_` and `%` are not wildcards.
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-x_y'] }), ['11|events.get|false|1']);
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-p%q'] }), ['11|events.get|false|1']);
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-%'] }), []);
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-unknown'] }), []);
        });

        it('[ASQ3B] must deny, never drop the filter, when the access filter is empty or unreadable', async () => {
          for (const accessStreamIds of [[], null, ['*'], ['access-a', '*'], [42], [''], 'access-a', {}]) {
            assert.deepStrictEqual(await summary(dbA, { accessStreamIds }), [], JSON.stringify(accessStreamIds));
          }
        });

        it('[ASQB] must deny an id holding a space, a non-ASCII character, or no letter or digit', async () => {
          for (const bad of ['access-a b', 'access-é', 'accèss-a', 'access-a\tb', '-:_', '%', '--']) {
            for (const accessStreamIds of [[bad], ['access-a', bad]]) {
              assert.deepStrictEqual(await summary(dbA, { accessStreamIds }), [], JSON.stringify(accessStreamIds));
            }
          }
          // The same ids, valid, still count.
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-a'] }), ACCESS_A);
        });

        it('[ASQ8] must never count a row the same engine\'s getEvents would not list for the access filter', async () => {
          // Rows holding an id glued to another by a non-token character
          // (`/`, `%`): a full-text engine may list them for a prefix id,
          // the summary does not count them (the safe direction).
          const glued = [['s8-g1', ['foo/access-a8']], ['s8-g2', ['access-a8%b']], ['s8-g3', ['access-a8%c', 'other-x']]];
          const clean = [
            ['s8-1', ['Access-Mixed8']],
            ['s8-2', ['access-a8', 'access-a8:2']],
            ['s8-3', ['access-a8']],
            ['s8-4', ['xaccess-a8']],
            ['s8-5', ['access-a8x']],
            ['s8-6', ['access-a8.b']],
            ['s8-7', ['access-a8_b']]
          ];
          const asRows = (list) => list.map(([id, streams], i) => [id, 50000 + i, 'events.get', OK, streams]);
          const full = await storage.forUser(userId + '-sum8f');
          const cleanDb = await storage.forUser(userId + '-sum8c');
          try {
            await insert(full, asRows([...clean, ...glued]));
            await insert(cleanDb, asRows(clean));
            const requests = [
              ['access-mixed8'], ['ACCESS-MIXED8'], ['access-a8'], ['ACCESS-A8'], ['access-a8:2'], ['access-unknown8'],
              ['access-a8%c'], ['access-a8%'], ['access-a8_b'], ['access-a8_'], ['access-a8.b'],
              ['access-a8', 'access-a8:2'], ['access-a8', 'ACCESS-A8']
            ];
            const counted = async (db, ids) => (await db.summarize({ fromTime: 0, toTime: 100000, slotSeconds: H, accessStreamIds: ids }))
              .reduce((sum, g) => sum + g.count, 0);
            const listed = async (db, ids) => (await db.getEvents({ query: [{ type: 'streamsQuery', content: [[{ any: ids }]] }] })).length;
            // An id holding a character a full-text engine splits on (`%`) may
            // list more there; equality is required for the other ids.
            const tokenOnly = (ids) => ids.every((id) => /^[A-Za-z0-9_:.-]+$/.test(id));
            for (const ids of requests) {
              const label = JSON.stringify(ids);
              assert.ok(await counted(full, ids) <= await listed(full, ids), label + ': never above what getEvents lists');
              if (tokenOnly(ids)) {
                assert.strictEqual(await counted(cleanDb, ids), await listed(cleanDb, ids), label + ': equal without glued rows');
              } else {
                assert.ok(await counted(cleanDb, ids) <= await listed(cleanDb, ids), label + ': never above what getEvents lists');
              }
            }
            // `%` and `_` are literal.
            assert.strictEqual(await counted(full, ['access-a8%']), 0);
            assert.strictEqual(await counted(full, ['access-a8%c']), 1);
            assert.strictEqual(await counted(full, ['access-a8_']), 0);
            assert.strictEqual(await counted(full, ['access-a8_b']), 1);
            // A row carrying two requested ids counts once.
            assert.strictEqual(await counted(cleanDb, ['access-a8', 'access-a8:2']), 2);
            assert.strictEqual(await counted(cleanDb, ['access-a8:2']), 1);
          } finally {
            await storage.deleteUser(userId + '-sum8f');
            await storage.deleteUser(userId + '-sum8c');
          }
        });

        it('[ASQ4] must not count history or deleted rows', async () => {
          assert.deepStrictEqual(await summary(dbA, { fromTime: 36040, toTime: 36070 }), []);
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-h'] }), []);
        });

        it('[ASQ5] must never count another user\'s rows', async () => {
          assert.deepStrictEqual(await summary(dbA, {}), ALL_A);
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-b2'] }), []);
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-a'] }), ACCESS_A);
          // Two ids: a disjunction must stay bound to this user on every branch.
          assert.deepStrictEqual(await summary(dbA, { accessStreamIds: ['access-b2', 'access-a'] }), ACCESS_A);
          assert.deepStrictEqual(await summary(dbB, {}), ['10|events.get|false|2']);
          assert.deepStrictEqual(await summary(dbB, { accessStreamIds: ['access-a'] }), ['10|events.get|false|1']);
        });

        it('[ASQ6] windowed engines must give the same groups whatever the window size', async function () {
          if (typeof engineHooks.setSummaryChunkRows !== 'function') return this.skip();
          const cases = [{}, { accessStreamIds: ['access-a', 'access-b'] }, { accessStreamIds: ['access-a'] }, { fromTime: 0, toTime: 100 * H }];
          const reference = [];
          for (const params of cases) reference.push(await summary(dbA, params));
          for (const rows of [1, 3]) {
            const previous = engineHooks.setSummaryChunkRows(rows);
            try {
              for (let i = 0; i < cases.length; i++) {
                assert.deepStrictEqual(await summary(dbA, cases[i]), reference[i], `window ${rows}, case ${i}`);
              }
            } finally {
              engineHooks.setSummaryChunkRows(previous);
            }
          }
          assert.deepStrictEqual(reference[0], ALL_A);
        });

        it('[ASQ7] must throw the budget error once the deadline has passed', async () => {
          for (const accessStreamIds of [undefined, ['access-a']]) {
            await assert.rejects(
              dbA.summarize({ fromTime: 10 * H, toTime: 13 * H, slotSeconds: H, accessStreamIds, deadline: Date.now() - 1 }),
              (err) => err.code === SUMMARY_BUDGET_ERROR_CODE);
          }
          assert.deepStrictEqual(await summary(dbA, { deadline: Date.now() + 60_000 }), ALL_A);
        });
      });

      it('[SQ16] deleteUser() must remove the user database', async () => {
        const deleteUserId = getUserId() + '-del';
        const delDb = await storage.forUser(deleteUserId);
        await delDb.createEvent({
          id: 'sq-del-event',
          streamIds: ['sq-stream'],
          type: 'test/test',
          time: 1000,
          created: 1000,
          createdBy: 'test',
          modified: 1000,
          modifiedBy: 'test'
        });
        await storage.deleteUser(deleteUserId);
        // After deletion, forUser should return a fresh empty database
        const freshDb = await storage.forUser(deleteUserId);
        assert.strictEqual(await freshDb.countEvents(), 0);
        await storage.deleteUser(deleteUserId);
      });
    });
  });
}
