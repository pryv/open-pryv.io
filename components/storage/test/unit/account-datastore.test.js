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
const accountStore = require('storages/datastores/account/index.ts').default;

// Mock system stream tree (mimics what systemStreams config produces)
const mockStreamTree = [
  {
    id: ':_system:account',
    name: 'Account',
    type: 'none/none',
    parentId: null,
    children: [
      {
        id: ':_system:language',
        name: 'Language',
        type: 'language/iso-639-1',
        parentId: ':_system:account',
        children: []
      },
      {
        id: ':system:email',
        name: 'Email',
        type: 'email/string',
        isUnique: true,
        parentId: ':_system:account',
        children: []
      },
      {
        id: ':system:phone',
        name: 'Phone',
        type: 'count/generic',
        parentId: ':_system:account',
        children: []
      }
    ]
  }
];

// Mock userAccountStorage
// (per user and field, a newest-first history of { value, time, createdBy })
function createMockStorage () {
  const data = {};
  const historyOf = (userId, field) => (data[userId] && data[userId][field]) || [];
  return {
    async getAccountFields (userId) {
      const fields = {};
      for (const field of Object.keys(data[userId] || {})) fields[field] = historyOf(userId, field)[0].value;
      return fields;
    },
    async getAccountFieldsWithMeta (userId) {
      const fields = {};
      for (const field of Object.keys(data[userId] || {})) {
        const history = historyOf(userId, field);
        fields[field] = { ...history[0], firstTime: history[history.length - 1].time };
      }
      return fields;
    },
    async getAccountField (userId, field) {
      const history = historyOf(userId, field);
      return history.length > 0 ? history[0].value : null;
    },
    async setAccountField (userId, field, value, createdBy, time) {
      if (!data[userId]) data[userId] = {};
      data[userId][field] = [{ value, time, createdBy }].concat(historyOf(userId, field));
      return { field, value, time, createdBy };
    },
    async getAccountFieldHistory (userId, field, limit) {
      return historyOf(userId, field).slice(0, limit);
    },
    async deleteAccountField (userId, field) {
      if (data[userId]) delete data[userId][field];
    },
    _clear () { Object.keys(data).forEach(k => delete data[k]); }
  };
}

describe('[ACDS] Account DataStore adapter', () => {
  const userId = cuid();
  let mockStorage;

  before(async () => {
    mockStorage = createMockStorage();
    // Override the lazy storage getter by initializing with a custom settings
    // that provides the mock storage directly
    await accountStore.init({
      id: 'account',
      name: 'Account',
      settings: {
        streamTree: mockStreamTree
      },
      storeKeyValueData: { get: async () => null, set: async () => {}, getAll: async () => ({}) },
      logger: { debug () {}, info () {}, warn () {}, error () {} }
    });
    // Inject mock storage via the events module (use cloned tree since init mutates)
    const AccountUserEvents = require('storages/datastores/account/AccountUserEvents.ts');
    accountStore.events = AccountUserEvents.create(
      buildFieldStreamMap(structuredClone(mockStreamTree)),
      async () => mockStorage
    );
  });

  afterEach(() => {
    mockStorage._clear();
  });

  describe('[DS01] Streams', () => {
    it('[DS1A] returns the stream tree on get()', async () => {
      const streams = await accountStore.streams.get(userId, { parentId: '*' });
      assert.strictEqual(streams.length, 1);
      assert.strictEqual(streams[0].id, ':_system:account');
      assert.strictEqual(streams[0].children.length, 3);
    });

    it('[DS1B] returns a single stream via getOne()', async () => {
      const stream = await accountStore.streams.getOne(userId, ':_system:language', {});
      assert.ok(stream);
      assert.strictEqual(stream.name, 'Language');
    });

    it('[DS1C] returns null for unknown stream', async () => {
      const stream = await accountStore.streams.getOne(userId, 'nonexistent', {});
      assert.strictEqual(stream, null);
    });

    it('[DS1D] rejects stream create', async () => {
      await assert.rejects(
        () => accountStore.streams.create(userId, { id: 'new', name: 'New' }),
        (err) => { assert.strictEqual(err.id, 'invalid-operation'); return true; }
      );
    });

    it('[DS1E] rejects stream update', async () => {
      await assert.rejects(
        () => accountStore.streams.update(userId, { id: ':_system:language', name: 'Lang' }),
        (err) => { assert.strictEqual(err.id, 'invalid-operation'); return true; }
      );
    });

    it('[DS1F] rejects stream delete', async () => {
      await assert.rejects(
        () => accountStore.streams.delete(userId, ':_system:language'),
        (err) => { assert.strictEqual(err.id, 'invalid-operation'); return true; }
      );
    });

    it('[DS1G] getDeletions returns empty array', async () => {
      const deletions = await accountStore.streams.getDeletions(userId, 0);
      assert.deepStrictEqual(deletions, []);
    });

    it('[DS1H] returns children of a parent stream', async () => {
      const children = await accountStore.streams.get(userId, { parentId: ':_system:account' });
      assert.strictEqual(children.length, 3);
      assert.strictEqual(children[0].id, ':_system:language');
    });
  });

  describe('[DS02] Events', () => {
    it('[DS2A] returns empty events when no fields set', async () => {
      const events = await accountStore.events.get(userId, {}, {});
      assert.deepStrictEqual(events, []);
    });

    it('[DS2B] creates an event (sets a field)', async () => {
      const event = await accountStore.events.create(userId, {
        streamIds: [':_system:language'],
        type: 'language/iso-639-1',
        content: 'fr',
        createdBy: 'test-access'
      });
      assert.strictEqual(event.id, 'language');
      assert.strictEqual(event.content, 'fr');
      assert.strictEqual(event.type, 'language/iso-639-1');

      const stored = await mockStorage.getAccountField(userId, 'language');
      assert.strictEqual(stored, 'fr');
    });

    it('[DS2C] gets all events as fields', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);

      const events = await accountStore.events.get(userId, {}, {});
      assert.strictEqual(events.length, 2);
      const ids = events.map(e => e.id).sort();
      assert.deepStrictEqual(ids, ['email', 'language']);
    });

    it('[DS2D] getOne returns a single event', async () => {
      await mockStorage.setAccountField(userId, 'email', 'x@y.com', 'test', 1000);
      const event = await accountStore.events.getOne(userId, 'email');
      assert.ok(event);
      assert.strictEqual(event.content, 'x@y.com');
      assert.strictEqual(event.streamIds[0], ':system:email');
    });

    it('[DS2E] getOne returns null for unknown field', async () => {
      const event = await accountStore.events.getOne(userId, 'nonexistent');
      assert.strictEqual(event, null);
    });

    it('[DS2F] updates an event (sets new value)', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      const updated = await accountStore.events.update(userId, {
        id: 'language',
        content: 'de',
        modifiedBy: 'test-access'
      });
      assert.strictEqual(updated, true);
      const value = await mockStorage.getAccountField(userId, 'language');
      assert.strictEqual(value, 'de');
    });

    it('[DS2G] delete is blocked (account events cannot be deleted)', async () => {
      await mockStorage.setAccountField(userId, 'email', 'x@y.com', 'test', 1000);
      await assert.rejects(
        () => accountStore.events.delete(userId, 'email'),
        (err) => {
          assert.strictEqual(err.id, 'api-unavailable');
          return true;
        }
      );
      // Value should still exist
      const value = await mockStorage.getAccountField(userId, 'email');
      assert.strictEqual(value, 'x@y.com');
    });

    it('[DS2H] getStreamed returns a readable stream', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      const stream = await accountStore.events.getStreamed(userId, {}, {});
      const events = [];
      for await (const e of stream) {
        events.push(e);
      }
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].id, 'language');
    });

    it('[DS2I] getHistory returns field history', async () => {
      // getHistory returns previous versions only (the current value is the event itself)
      await mockStorage.setAccountField(userId, 'email', 'x@y.com', 'test', 1000);
      await mockStorage.setAccountField(userId, 'email', 'z@y.com', 'test', 2000);
      const history = await accountStore.events.getHistory(userId, 'email');
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].content, 'x@y.com');
      assert.strictEqual(history[0].time, 1000);
    });

    it('[DS2J] getDeletionsStreamed returns empty stream', async () => {
      const stream = await accountStore.events.getDeletionsStreamed(userId, { deletedSince: 0 }, {});
      const items = [];
      for await (const item of stream) {
        items.push(item);
      }
      assert.strictEqual(items.length, 0);
    });
  });

  describe('[DS03] StreamIds and query filtering', () => {
    it('[DS3A] events have only the field stream ID', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      const event = await accountStore.events.getOne(userId, 'language');
      assert.deepStrictEqual(event.streamIds, [':_system:language']);
    });

    it('[DS3B] unique fields have only the field stream ID (no markers)', async () => {
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      const event = await accountStore.events.getOne(userId, 'email');
      assert.deepStrictEqual(event.streamIds, [':system:email']);
    });

    it('[DS3D] create extracts field name from streamIds', async () => {
      const event = await accountStore.events.create(userId, {
        streamIds: [':_system:language'],
        type: 'language/iso-639-1',
        content: 'it',
        createdBy: 'test'
      });
      assert.strictEqual(event.id, 'language');
      assert.strictEqual(event.content, 'it');
    });

    it('[DS3E] get filters by normalized stream query (any)', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      await mockStorage.setAccountField(userId, 'phone', '123', 'test', 1000);

      const events = await accountStore.events.get(userId, {
        streams: [[{ any: [':_system:language'] }]]
      }, {});
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].id, 'language');
    });

    it('[DS3G] get filters with not condition', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);

      const events = await accountStore.events.get(userId, {
        streams: [[{ any: [':_system:language', ':system:email'] }, { not: [':system:email'] }]]
      }, {});
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].id, 'language');
    });

    it('[DS3H] get applies skip and limit options', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      await mockStorage.setAccountField(userId, 'phone', '123', 'test', 1000);

      const events = await accountStore.events.get(userId, {}, { skip: 1, limit: 1 });
      assert.strictEqual(events.length, 1);
    });

    it('[DS3I] get filters by type', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);

      const events = await accountStore.events.get(userId, {
        types: ['email/string']
      }, {});
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].id, 'email');
    });

    it('[DS3K] get filters by a class wildcard type', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      const events = await accountStore.events.get(userId, { types: ['email/*'] }, {});
      assert.deepStrictEqual(events.map((e) => e.id), ['email']);
      const none = await accountStore.events.get(userId, { types: ['note/*'] }, {});
      assert.deepStrictEqual(none, []);
    });

    it('[DS3J] getHistory has only field stream ID', async () => {
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      await mockStorage.setAccountField(userId, 'email', 'c@b.com', 'test', 2000);
      const history = await accountStore.events.getHistory(userId, 'email');
      assert.strictEqual(history.length, 1);
      assert.deepStrictEqual(history[0].streamIds, [':system:email']);
    });
  });

  describe('[ATM00] Event times come from the stored history', () => {
    it('[ATM01] get() and getOne() return the stored times, identical across reads', async () => {
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'first', 1000);
      await mockStorage.setAccountField(userId, 'email', 'c@b.com', 'second', 2000);
      const [read1] = await accountStore.events.get(userId, { types: ['email/string'] }, {});
      const [read2] = await accountStore.events.get(userId, { types: ['email/string'] }, {});
      const one = await accountStore.events.getOne(userId, 'email');
      for (const event of [read1, read2, one]) {
        assert.strictEqual(event.content, 'c@b.com');
        assert.strictEqual(event.time, 2000);
        assert.strictEqual(event.modified, 2000);
        assert.strictEqual(event.modifiedBy, 'second');
      }
      assert.deepStrictEqual(read1, read2);
    });

    it('[ATM05] created is the time of the field\'s first entry', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      await mockStorage.setAccountField(userId, 'language', 'fr', 'test', 3000);
      const [event] = await accountStore.events.get(userId, { types: ['language/iso-639-1'] }, {});
      const one = await accountStore.events.getOne(userId, 'language');
      assert.strictEqual(event.created, 1000);
      assert.strictEqual(one.created, 1000);
      assert.strictEqual(event.time, 3000);
    });

    it('[ATM02] modifiedSince and time ranges filter on the stored times', async () => {
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      assert.strictEqual((await accountStore.events.get(userId, { modifiedSince: 1500 }, {})).length, 0);
      assert.strictEqual((await accountStore.events.get(userId, { modifiedSince: 500 }, {})).length, 1);
      assert.strictEqual((await accountStore.events.get(userId, { fromTime: 0, toTime: 900 }, {})).length, 0);
      assert.strictEqual((await accountStore.events.get(userId, { fromTime: 900, toTime: 1100 }, {})).length, 1);
    });
  });

  describe('[SIB2A] Derived events', () => {
    const AccountUserEvents = require('storages/datastores/account/AccountUserEvents.ts');
    let events;
    const calls = [];

    before(() => {
      const derivedFields = new Map([['emailVerification', {
        baseField: 'email',
        type: 'verification/email',
        provider: async (uid, base) => {
          calls.push(base.content);
          return { content: { verified: true, method: 'email-link', verifiedAt: 1500 }, modified: 2500 };
        }
      }]]);
      events = AccountUserEvents.create(buildFieldStreamMap(structuredClone(mockStreamTree)), async () => mockStorage, derivedFields);
    });

    it('[SIB20] get() returns derived events only when the query asks for them, by flag AND by type', async () => {
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1200);
      const plain = await events.get(userId, {}, {});
      assert.deepStrictEqual(plain.map((e) => e.id).sort(), ['email', 'language']);
      // the flag alone (an API read without `types`) keeps one event per field
      const before0 = calls.length;
      const flagOnly = await events.get(userId, { includeDerived: true }, {});
      assert.deepStrictEqual(flagOnly.map((e) => e.id).sort(), ['email', 'language']);
      assert.strictEqual(calls.length, before0, 'provider not called without types');
      // the type alone (an internal reader) never gets it either
      assert.deepStrictEqual((await events.get(userId, { types: ['verification/email'] }, {})).map((e) => e.id), []);
      const withDerived = await events.get(userId, { includeDerived: true, types: ['email/string', 'verification/email'] }, { sortAscending: false });
      const ids = withDerived.map((e) => e.id);
      assert.ok(ids.indexOf('emailVerification') === ids.indexOf('email') + 1, 'derived right after its base: ' + ids);
      const derived = withDerived.find((e) => e.id === 'emailVerification');
      assert.deepStrictEqual(derived.streamIds, [':system:email']);
      assert.strictEqual(derived.type, 'verification/email');
      assert.strictEqual(derived.time, 1000, 'the base event time');
      assert.strictEqual(derived.modified, 2500, 'the latest of the two changes');
      assert.deepStrictEqual(calls.at(-1), 'a@b.com');
      // filters apply to derived events too, and a class wildcard asks for them
      const onlyType = await events.get(userId, { includeDerived: true, types: ['verification/email'] }, {});
      assert.deepStrictEqual(onlyType.map((e) => e.id), ['emailVerification']);
      const wildcard = await events.get(userId, { includeDerived: true, types: ['verification/*'] }, {});
      assert.deepStrictEqual(wildcard.map((e) => e.id), ['emailVerification']);
      // and a derived event the query cannot return is not computed
      const before = calls.length;
      await events.get(userId, { includeDerived: true, types: ['email/string'] }, {});
      await events.get(userId, { includeDerived: true, streams: [{ any: [':_system:language'] }] }, {});
      assert.strictEqual(calls.length, before, 'provider not called');
    });

    it('[SIB23] a real field of the same name wins over a derived one', async () => {
      const tree = structuredClone(mockStreamTree);
      tree[0].children.push({ id: ':system:emailVerification', name: 'Op field', type: 'note/txt', parentId: ':_system:account', children: [] });
      const shadowed = AccountUserEvents.create(buildFieldStreamMap(tree), async () => mockStorage, new Map([['emailVerification', {
        baseField: 'email', type: 'verification/email', provider: async () => ({ content: { verified: true } })
      }]]));
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      await mockStorage.setAccountField(userId, 'emailVerification', 'operator value', 'test', 1100);
      const all = await shadowed.get(userId, { includeDerived: true, types: ['note/txt', 'verification/email'] }, {});
      const same = all.filter((e) => e.id === 'emailVerification');
      assert.strictEqual(same.length, 1);
      assert.strictEqual(same[0].type, 'note/txt');
      assert.strictEqual((await shadowed.getOne(userId, 'emailVerification')).content, 'operator value');
    });

    it('[SIB21] getOne() resolves the derived id; it has no history', async () => {
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      const one = await events.getOne(userId, ':system:emailVerification');
      assert.strictEqual(one.id, 'emailVerification');
      assert.strictEqual(one.content.verified, true);
      assert.deepStrictEqual(await events.getHistory(userId, ':system:emailVerification'), []);
    });

    it('[SIB16] no base value, no derived event', async () => {
      await mockStorage.setAccountField(userId, 'language', 'en', 'test', 1000);
      const all = await events.get(userId, { includeDerived: true, types: ['language/iso-639-1', 'verification/email'] }, {});
      assert.deepStrictEqual(all.map((e) => e.id), ['language']);
      assert.strictEqual(await events.getOne(userId, ':system:emailVerification'), null);
    });

    it('[SIB15] a derived event cannot be written', async () => {
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      await assert.rejects(
        () => events.update(userId, { id: 'emailVerification', content: { verified: false } }),
        (err) => { assert.strictEqual(err.id, 'api-unavailable'); return true; }
      );
      assert.ok(!('emailVerification' in await mockStorage.getAccountFields(userId)));
    });
  });
});

// Helper — same as index.js buildFieldStreamMap
function buildFieldStreamMap (streamTree) {
  const map = new Map();
  collectLeaves(streamTree);
  return map;

  function collectLeaves (streams) {
    for (const s of streams) {
      if (s.children && s.children.length > 0) {
        collectLeaves(s.children);
      }
      if (s.type !== 'none/none') {
        const lastColon = s.id.lastIndexOf(':');
        const fieldName = lastColon >= 0 ? s.id.substring(lastColon + 1) : s.id;
        map.set(fieldName, s);
      }
    }
  }
}
