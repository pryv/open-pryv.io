/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert');
const cuid = require('cuid');

const helpers = require('../../../test/helpers');
const { SqliteStorage: Storage } = require('../src/userSQLite/Storage.ts');
const { _setSetFrom } = require('../src/userSQLite/streamQueryUtils.ts');

// The events query of the SQLite engine, called directly (no API validator in
// front): every value is bound, never SQL text, and a stream id matches only
// an equal stored id (letter case included), never a phrase inside another id.
describe('[SQQB] SQLite events query: bound values, exact stream ids', function () {
  const userLocalDirectory = helpers.userLocalDirectory;
  const userId = cuid();
  let storage, userDb;

  const events = [
    { id: 'lower', streamIds: ['abc'], type: 'note/txt', description: "don't", content: { k: '50% off' } },
    { id: 'upper', streamIds: ['ABC'], type: 'notebook/txt', description: 'a\u0000b', content: { k: '500 off' } },
    { id: 'split', streamIds: ['abc/def'], type: 'note_txt/x' },
    { id: 'pair', streamIds: ['x', 'y'], type: 'note/txt' },
    { id: 'quote', streamIds: ["it's", 'a"b'], type: 'note/txt' },
    { id: 'audit', streamIds: ['access-sqqbaccess', 'action-callBatch'], type: 'log/user-api' },
    { id: 'near1', streamIds: ['access-ab'], type: 'log/user-api' },
    { id: 'near2', streamIds: ['xaccess-a', 'access-a.b'], type: 'log/user-api' },
    { id: 'near3', streamIds: ['foo', 'access-a:3'], type: 'log/user-api' },
    { id: 'slash', streamIds: ['/'], type: 'misc/x' },
    { id: 'at', streamIds: ['@'], type: 'misc/x' },
    { id: 'ete', streamIds: ['Été'], type: 'misc/x' },
    { id: 'znum', streamIds: ['123'], type: 'misc/x' },
    { id: 'zbool', streamIds: ['true'], type: 'misc/x' }
  ];
  const ALL = events.map((e) => e.id).sort();
  const without = (...out) => ALL.filter((id) => !out.includes(id));
  const q = (n, prefix = 'q') => Array.from({ length: n }, (_, k) => prefix + k);

  async function fill (db) {
    for (const e of events) {
      await db.createEvent({ time: 1000, created: 1000, createdBy: 'test', modified: 1000, modifiedBy: 'test', ...e });
    }
  }

  before(async function () {
    await helpers.dependencies.init();
    await userLocalDirectory.init();
    storage = new Storage('sqqb-' + cuid.slug());
    await storage.init();
    userDb = await storage.forUser(userId);
    await fill(userDb);
  });

  after(async function () {
    storage.close();
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  async function ids (query, options) {
    return (await userDb.getEvents({ query, options })).map((e) => e.id).sort();
  }
  const streams = (content) => ({ type: 'streamsQuery', content });

  /** The SQL text of a `getEvents` call (from its debug line) and its rows. */
  function sqlAndIds (query) {
    let sql = null;
    const debug = userDb.logger.debug;
    userDb.logger.debug = (msg) => { if (typeof msg === 'string' && msg.startsWith('GET events: ')) sql = msg; };
    try {
      return { rows: userDb.getEvents({ query, options: { sort: { time: -1 }, limit: 50 } }).map((e) => e.id).sort(), sql };
    } finally {
      userDb.logger.debug = debug;
    }
  }

  it('[SQQB1] an "any" id matches only an equal stored id, letter case included, not a phrase inside another id', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc'] }]])]), ['lower']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['ABC'] }]])]), ['upper']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['def'] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc/def'] }]])]), ['split']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['ABC/DEF', 'x'] }]])]), ['pair']);
  });

  it('[SQQB2] a "not" id drops only an equal stored id', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: ['abc'] }]])]), without('lower'));
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', 'abc/def'] }, { not: ['def'] }]])]), ['lower', 'split']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc/def'] }], [{ any: ['x'] }, { not: ['y'] }]])]), ['split']);
  });

  it('[SQQB3] an id holding the id separator matches no event, even two stored ids next to each other', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['x y'] }]])]), []);
  });

  it('[SQQB4] ids and values with quotes, LIKE wildcards or NUL match literally', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ["it's"] }]])]), ['quote']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['a"b'] }]])]), ['quote']);
    assert.deepStrictEqual(await ids([{ type: 'equal', content: { field: 'description', value: "don't" } }]), ['lower']);
    assert.deepStrictEqual(await ids([{ type: 'equal', content: { field: 'description', value: 'a\u0000b' } }]), ['upper']);
    assert.deepStrictEqual(await ids([{ type: 'equal', content: { field: 'description', value: "' OR '1'='1" } }]), []);
    assert.deepStrictEqual(await ids([{ type: 'typesList', content: ['n_te/*'] }]), [], '_ is not a wildcard');
    assert.deepStrictEqual(await ids([{ type: 'typesList', content: ['note_txt/*'] }]), ['split']);
    assert.deepStrictEqual(await ids([{ type: 'typesList', content: ['note/*'] }]), ['lower', 'pair', 'quote'], 'the slash is kept');
    const prefix = { type: 'jsonCondition', content: { field: 'content', path: ['k'], op: 'prefix', value: '50%' } };
    assert.deepStrictEqual(await ids([prefix]), ['lower'], '% is not a wildcard');
  });

  it('[SQQB7] an id never matches a stored id it is a part of (prefix, suffix, before a punctuation)', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['access-a'] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['access-ab'] }]])]), ['near1']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['access-a.b'] }]])]), ['near2']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['access-a:3'] }]])]), ['near3']);
  });

  // From 8 ids a group is one bound list: a row of token characters only is
  // split and its ids looked up in the list; the other rows (`abc/def`,
  // quotes, `Été`) are checked id by id.
  it('[SQQB8] with many ids, rows of any kind still match exactly, with "any" and with "not"', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', 'access-a', 'access-ab', 'x', ...q(4)] }]])]), ['lower', 'near1', 'pair']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['ABC', 'access-a', 'access-ab', 'x', ...q(4)] }]])]), ['near1', 'pair', 'upper']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: ['abc', 'x', ...q(6)] }]])]), without('lower', 'pair'));
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', 'abc/def', 'x'] }, { not: ['y', ...q(7)] }]])]), ['lower', 'split']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['ABC', 'x', 'access-ab', ...q(5)] }, { not: ['abc'] }]])]), ['near1', 'pair', 'upper']);
  });

  it('[SQQB9] an id with no full-text token character (`/`, `@`) still finds its events', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['/'] }]])]), ['slash']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', '@'] }]])]), ['at', 'lower']);
  });

  it('[SQQBA] the tag every event carries, and the empty id, match no event', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['..'] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: [''] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['..', ...q(7)] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: ['..'] }]])]), ALL);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: ['..', ...q(7)] }]])]), ALL);
  });

  it('[SQQBB] "not" only with many ids walks the time index, no full-text read', function () {
    const { rows, sql } = sqlAndIds([streams([[{ any: ['*'] }, { not: ['abc', 'x', ...q(6)] }]])]);
    assert.deepStrictEqual(rows, without('lower', 'pair'));
    assert.ok(!sql.includes('NOT INDEXED'), sql);
    assert.ok(!sql.includes('events_fts'), sql);
  });

  it('[SQQBC] with many ids, the bound list gives the rows of the id-by-id condition', async function () {
    const many = ['abc', 'x', 'access-ab', 'access-a', ...q(4)];
    const queries = [
      [[{ any: many }]],
      [[{ any: many }, { not: ['y', 'abc'] }]],
      [[{ any: ['*'] }, { not: many }]],
      [[{ any: many.slice(0, 4) }], [{ any: many.slice(4) }, { not: ['x'] }]],
      [[{ any: ['abc'] }], [{ any: ['*'] }, { not: many }]],
      [[{ any: ['abc', 'x', ...q(6)] }, { any: ['x', 'y', 'access-ab', ...q(5, 'p')] }, { not: ['q4', 'q5'] }]]
    ];
    const asList = [];
    for (const query of queries) asList.push(await ids([streams(query)]));
    const previous = _setSetFrom(1e9);
    try {
      for (const [i, query] of queries.entries()) assert.deepStrictEqual(await ids([streams(query)]), asList[i], JSON.stringify(query));
    } finally {
      _setSetFrom(previous);
    }
    assert.deepStrictEqual(asList[0], ['lower', 'near1', 'pair']);
    assert.deepStrictEqual(asList[5], ['pair'], 'two "any" groups are ANDed');
  });

  it('[SQQBF] an item with no id, or with both "any" and "not", is refused (never read as "every event")', function () {
    const bad = [
      [[{ any: [] }]],
      [[{ not: [] }]],
      [[{}]],
      [[{ any: [] }, { any: ['abc'] }]],
      [[{ any: ['abc'], not: ['x'] }]],
      [[{ any: ['abc'] }], [{ any: [] }]]
    ];
    for (const query of bad) assert.throws(() => userDb.getEvents({ query: [streams(query)] }), /exactly one non-empty any or not/, JSON.stringify(query));
  });

  it('[SQQBG] a stream id holding NUL never returns more than its own events', async function () {
    let alone;
    try { alone = await ids([streams([[{ any: ['a\u0000b'] }]])]); } catch (e) { alone = []; } // refused or empty
    assert.deepStrictEqual(alone, []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['a\u0000b', '/'] }]])]), ['slash']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['a\u0000b', '/', ...q(6)] }]])]), ['slash']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['a\u0000b', 'abc'] }]])]), ['lower']);
  });

  it('[SQQBN] a stored row holding NUL (written before the write guard) never breaks nor widens a long list', async function () {
    const otherId = cuid();
    const otherDb = await storage.forUser(otherId);
    try {
      await fill(otherDb);
      const raw = otherDb.db.prepare('INSERT INTO events (eventid, streamIds, time, type) VALUES (?, ?, 1000, ?)');
      raw.run('nul1', 'abc\u0000 ..', 'misc/x');
      raw.run('nul2', 'a\u0000","x ..', 'misc/x');
      const list = ['x', 'abc', ...q(6)];
      const got = async (block) => (await otherDb.getEvents({ query: [streams([block])] })).map((e) => e.id).sort();
      assert.deepStrictEqual(await got([{ any: list }]), ['lower', 'pair']);
      assert.deepStrictEqual(await got([{ any: ['*'] }, { not: list }]), [...without('lower', 'pair'), 'nul1', 'nul2'].sort());
    } finally {
      await userLocalDirectory.deleteUserDirectory(otherId);
    }
  });

  it('[SQQBD] a non-ASCII id matches its stored case only (no case folding at all)', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['été', ...q(7)] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['Été', ...q(7)] }]])]), ['ete']);
  });

  it('[SQQBE] a list longer than the bound-variable limit of SQLite (an expanded tree) is matched exactly', async function () {
    const filler = q(40000, 'f');
    assert.deepStrictEqual(await ids([streams([[{ any: [...filler, 'abc', 'abc/def', '..'] }]])]), ['lower', 'split']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: [...filler, 'abc', 'x'] }]])]), without('lower', 'pair'));
    assert.deepStrictEqual(await ids([streams([[{ any: [...filler, '/', 'access-ab'] }, { not: ['@'] }]])]), ['near1', 'slash']);
  });

  it('[SQQBI] one id that is not a full-text token in a long list keeps the bound list', function () {
    const { rows, sql } = sqlAndIds([streams([[{ any: ['abc', 'x', 'a/b', 'é', ...q(4)] }]])]);
    assert.deepStrictEqual(rows, ['lower', 'pair']);
    assert.ok(sql.includes("json_each('[\"'"), sql);
  });

  it('[SQQBJ] a long list on rows outside the token characters is matched id by id, with "any" and with "not"', async function () {
    const odd = ['abc/def', "it's", 'Été', '/', '@', ...q(3)];
    assert.deepStrictEqual(await ids([streams([[{ any: odd }]])]), ['at', 'ete', 'quote', 'slash', 'split']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: odd }]])]), without('at', 'ete', 'quote', 'slash', 'split'));
  });

  it('[SQQBK] ids differing only by case are distinct, in one list and across groups and blocks', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', 'ABC', ...q(6)] }]])]), ['lower', 'upper']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', 'ABC', ...q(6)] }, { not: ['ABC', ...q(7, 'p')] }]])]), ['lower']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['ABC', ...q(7)] }], [{ any: ['*'] }, { not: ['abc', 'ABC', 'x', ...q(5)] }]])]), without('lower', 'pair'));
  });

  it('[SQQBL] ids that read as JSON values or JSON syntax match only equal stored ids', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['123', 'true', 'null', '","', '"]', ...q(3)] }]])]), ['zbool', 'znum']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['null', '","', '"]', '1', ...q(4)] }]])]), []);
  });

  it('[SQQB6] audit actions are listed in stored case and found in that case only', async function () {
    const listed = userDb.getAllActions().map((t) => t.term);
    assert.ok(listed.includes('action-callBatch'), JSON.stringify(listed));
    assert.ok(!listed.includes('action-callbatch'), JSON.stringify(listed));
    assert.deepStrictEqual(await ids([streams([[{ any: ['action-callBatch'] }]])]), ['audit']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['action-callbatch'] }]])]), []);
  });

  it('[SQQBH] deleting with a stream filter keeps exactly the other events (full-text candidates one by one, or one statement)', async function () {
    const cases = [
      [[{ any: ['*'] }, { not: ['abc', 'x', ...q(6)] }], false, ['lower', 'pair']],
      [[{ any: ['*'] }, { not: ['abc'] }], false, ['lower']],
      [[{ any: ['abc', 'x'] }], true, without('lower', 'pair')]
    ];
    for (const [block, oneByOne, kept] of cases) {
      const otherId = cuid();
      const otherDb = await storage.forUser(otherId);
      try {
        await fill(otherDb);
        const messages = [];
        const debug = otherDb.logger.debug;
        otherDb.logger.debug = (msg) => { if (typeof msg === 'string') messages.push(msg); };
        try {
          await otherDb.deleteEvents({ query: [streams([block])] });
        } finally {
          otherDb.logger.debug = debug;
        }
        assert.strictEqual(messages.some((m) => m.startsWith('DELETE events one by one')), oneByOne, messages.join('\n'));
        const left = (await otherDb.getEvents({ query: [] })).map((e) => e.id).sort();
        assert.deepStrictEqual(left, kept, JSON.stringify(block));
      } finally {
        await userLocalDirectory.deleteUserDirectory(otherId);
      }
    }
  });

  it('[SQQBM] an event whose stream id is empty, "..", or holds a space or NUL is not stored', async function () {
    const before = userDb.countEvents();
    for (const bad of [['a b'], [''], ['..'], ['a\u0000b'], ['ok', ' x']]) {
      await assert.rejects(() => userDb.createEvent({ id: cuid(), time: 1000, streamIds: bad, type: 'misc/x' }), /cannot be stored/, JSON.stringify(bad));
    }
    assert.strictEqual(userDb.countEvents(), before);
  });

  it('[SQQB5] paging values are bound; an unknown column is refused', async function () {
    assert.deepStrictEqual((await userDb.getEvents({ query: [], options: { sort: { eventid: 1 }, limit: 2, skip: 7 } })).map((e) => e.id), ['pair', 'quote']);
    assert.throws(() => userDb.getEvents({ query: [{ type: 'equal', content: { field: 'type = type OR 1', value: 1 } }] }), /Unknown events column/);
    assert.throws(() => userDb.getEvents({ query: [], options: { sort: { 'time; DROP TABLE events': 1 } } }), /Unknown events column/);
  });
});
