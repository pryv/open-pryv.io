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
const { _setShortcutMinIds } = require('../src/userSQLite/streamQueryUtils.ts');

// The events query of the SQLite engine, called directly (no API validator in
// front): every value is bound, never SQL text, and a stream id matches only
// an equal stored id (ASCII case folded), never a phrase inside another id.
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
    { id: 'ete', streamIds: ['Été'], type: 'misc/x' }
  ];
  const ALL = events.map((e) => e.id).sort();
  const without = (...out) => ALL.filter((id) => !out.includes(id));

  before(async function () {
    await helpers.dependencies.init();
    await userLocalDirectory.init();
    storage = new Storage('sqqb-' + cuid.slug());
    await storage.init();
    userDb = await storage.forUser(userId);
    for (const e of events) {
      await userDb.createEvent({ time: 1000, created: 1000, createdBy: 'test', modified: 1000, modifiedBy: 'test', ...e });
    }
  });

  after(async function () {
    storage.close();
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  async function ids (query, options) {
    return (await userDb.getEvents({ query, options })).map((e) => e.id).sort();
  }
  const streams = (content) => ({ type: 'streamsQuery', content });

  it('[SQQB1] an "any" id matches only an equal stored id (ASCII case folded), not a phrase inside another id', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc'] }]])]), ['lower', 'upper']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['def'] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc/def'] }]])]), ['split']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['ABC/DEF', 'x'] }]])]), ['pair', 'split']);
  });

  it('[SQQB2] a "not" id drops only an equal stored id', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: ['abc'] }]])]), without('lower', 'upper'));
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', 'abc/def'] }, { not: ['def'] }]])]), ['lower', 'split', 'upper']);
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

  // From 8 single-token ids, a row of token characters only is matched through
  // the full-text index; the other rows (`abc/def`, quotes) by the exact check.
  it('[SQQB8] with many ids, rows of any kind still match exactly, with "any" and with "not"', async function () {
    const more = ['q1', 'q2', 'q3', 'q4'];
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', 'access-a', 'access-ab', 'x', ...more] }]])]), ['lower', 'near1', 'pair', 'upper']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: ['abc', 'x', 'q0', ...more, 'q5'] }]])]), without('lower', 'upper', 'pair'));
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', 'abc/def', 'x'] }, { not: ['y', 'q0', ...more, 'q5'] }]])]), ['lower', 'split', 'upper'], 'an id that is not one token: the exact check only');
    assert.deepStrictEqual(await ids([streams([[{ any: ['ABC', 'x', 'access-ab', 'q0', ...more] }, { not: ['abc'] }]])]), ['near1', 'pair']);
  });

  it('[SQQB9] an id with no full-text token character (`/`, `@`) still finds its events', async function () {
    assert.deepStrictEqual(await ids([streams([[{ any: ['/'] }]])]), ['slash']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['abc', '@'] }]])]), ['at', 'lower', 'upper']);
  });

  it('[SQQBA] the tag every event carries, and the empty id, match no event', async function () {
    const q = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
    assert.deepStrictEqual(await ids([streams([[{ any: ['..'] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: [''] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['..', ...q] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: ['..'] }]])]), ALL);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: ['..', ...q] }]])]), ALL);
  });

  it('[SQQBB] "not" only with many ids walks the time index (no read of the whole table)', async function () {
    let sql = null;
    const debug = userDb.logger.debug;
    userDb.logger.debug = (msg) => { if (typeof msg === 'string' && msg.startsWith('GET events: ')) sql = msg; };
    let rows;
    try {
      rows = userDb.getEvents({ query: [streams([[{ any: ['*'] }, { not: ['abc', 'x', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6'] }]])], options: { sort: { time: -1 }, limit: 50 } });
    } finally {
      userDb.logger.debug = debug;
    }
    assert.deepStrictEqual(rows.map((e) => e.id).sort(), without('lower', 'upper', 'pair'));
    assert.ok(!sql.includes('NOT INDEXED'), sql);
    assert.ok(sql.includes('rowid NOT IN (SELECT rowid FROM events_fts'), sql);
  });

  it('[SQQBC] with many ids, the full-text shortcut gives the rows of the exact condition alone', async function () {
    const many = ['abc', 'x', 'access-ab', 'access-a', 'q1', 'q2', 'q3', 'q4'];
    const queries = [
      [[{ any: many }]],
      [[{ any: many }, { not: ['y', 'abc'] }]],
      [[{ any: ['*'] }, { not: many }]],
      [[{ any: many.slice(0, 4) }], [{ any: many.slice(4) }, { not: ['x'] }]],
      [[{ any: ['abc'] }], [{ any: ['*'] }, { not: many }]],
      [[{ any: ['abc', 'x', 'q1', 'q2'] }, { any: ['x', 'y', 'access-ab', 'q3'] }, { not: ['q4', 'q5'] }]]
    ];
    const withShortcut = [];
    for (const q of queries) withShortcut.push(await ids([streams(q)]));
    const previous = _setShortcutMinIds(1e9);
    try {
      for (const [i, q] of queries.entries()) assert.deepStrictEqual(await ids([streams(q)]), withShortcut[i], JSON.stringify(q));
    } finally {
      _setShortcutMinIds(previous);
    }
    assert.deepStrictEqual(withShortcut[0], ['lower', 'near1', 'pair', 'upper']);
    assert.deepStrictEqual(withShortcut[5], ['pair'], 'two "any" groups are ANDed');
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
    for (const q of bad) assert.throws(() => userDb.getEvents({ query: [streams(q)] }), /exactly one non-empty any or not/, JSON.stringify(q));
  });

  it('[SQQBG] a stream id holding NUL never returns more than its own events', async function () {
    assert.throws(() => userDb.getEvents({ query: [streams([[{ any: ['a\u0000b'] }]])] }));
    assert.deepStrictEqual(await ids([streams([[{ any: ['a\u0000b', '/'] }]])]), ['slash']);
  });

  it('[SQQBD] a non-ASCII id matches its stored case only (ASCII folding, as `lower`)', async function () {
    const q = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
    assert.deepStrictEqual(await ids([streams([[{ any: ['été', ...q] }]])]), []);
    assert.deepStrictEqual(await ids([streams([[{ any: ['Été', ...q] }]])]), ['ete']);
  });

  it('[SQQBE] a list longer than the bound-variable limit of SQLite (an expanded tree) is matched exactly', async function () {
    const filler = Array.from({ length: 40000 }, (_, k) => 'f' + k);
    assert.deepStrictEqual(await ids([streams([[{ any: [...filler, 'abc', 'abc/def', '..'] }]])]), ['lower', 'split', 'upper']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: [...filler, 'abc', 'x'] }]])]), without('lower', 'upper', 'pair'));
    assert.deepStrictEqual(await ids([streams([[{ any: [...filler, '/', 'access-ab'] }, { not: ['@'] }]])]), ['near1', 'slash']);
    const previous = _setShortcutMinIds(1e9);
    try {
      assert.deepStrictEqual(await ids([streams([[{ any: ['*'] }, { not: [...filler, 'abc', 'x'] }]])]), without('lower', 'upper', 'pair'), 'exact condition alone');
    } finally {
      _setShortcutMinIds(previous);
    }
  });

  it('[SQQB6] an audit action listed by the store (lower-cased) finds the rows of its camelCase id', async function () {
    const listed = userDb.getAllActions().map((t) => t.term);
    assert.ok(listed.includes('action-callbatch'), JSON.stringify(listed));
    assert.deepStrictEqual(await ids([streams([[{ any: ['action-callbatch'] }]])]), ['audit']);
    assert.deepStrictEqual(await ids([streams([[{ any: ['action-callBatch'] }]])]), ['audit']);
  });

  it('[SQQBH] deleting with a "not" filter keeps exactly the matching events, by the full-text path (8+ ids) and the plain one', async function () {
    const many = ['abc', 'x', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
    for (const [not, oneByOne, kept] of [[many, true, ['lower', 'pair', 'upper']], [['abc'], false, ['lower', 'upper']]]) {
      const otherId = cuid();
      const otherDb = await storage.forUser(otherId);
      try {
        for (const e of events) {
          await otherDb.createEvent({ time: 1000, created: 1000, createdBy: 'test', modified: 1000, modifiedBy: 'test', ...e });
        }
        const messages = [];
        const debug = otherDb.logger.debug;
        otherDb.logger.debug = (msg) => { if (typeof msg === 'string') messages.push(msg); };
        try {
          await otherDb.deleteEvents({ query: [streams([[{ any: ['*'] }, { not }]])] });
        } finally {
          otherDb.logger.debug = debug;
        }
        assert.strictEqual(messages.some((m) => m.startsWith('DELETE events one by one')), oneByOne, messages.join('\n'));
        const left = (await otherDb.getEvents({ query: [] })).map((e) => e.id).sort();
        assert.deepStrictEqual(left, kept, JSON.stringify(not));
      } finally {
        await userLocalDirectory.deleteUserDirectory(otherId);
      }
    }
  });

  it('[SQQB5] paging values are bound; an unknown column is refused', async function () {
    assert.deepStrictEqual((await userDb.getEvents({ query: [], options: { sort: { eventid: 1 }, limit: 2, skip: 7 } })).map((e) => e.id), ['pair', 'quote']);
    assert.throws(() => userDb.getEvents({ query: [{ type: 'equal', content: { field: 'type = type OR 1', value: 1 } }] }), /Unknown events column/);
    assert.throws(() => userDb.getEvents({ query: [], options: { sort: { 'time; DROP TABLE events': 1 } } }), /Unknown events column/);
  });
});
