/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const cuid = require('cuid');
const accountStore = require('../index');

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
function createMockStorage () {
  const data = {};
  return {
    async getAccountFields (userId) {
      return Object.assign({}, data[userId] || {});
    },
    async getAccountField (userId, field) {
      return (data[userId] && data[userId][field]) || null;
    },
    async setAccountField (userId, field, value, createdBy, time) {
      if (!data[userId]) data[userId] = {};
      data[userId][field] = value;
      return { field, value, time, createdBy };
    },
    async getAccountFieldHistory (userId, field, limit) {
      const value = data[userId] && data[userId][field];
      if (value == null) return [];
      return [{ value, time: 1000, createdBy: 'test' }];
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
    const AccountUserEvents = require('../AccountUserEvents');
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
        (err) => { assert.strictEqual(err.id, 'unsupported-operation'); return true; }
      );
    });

    it('[DS1E] rejects stream update', async () => {
      await assert.rejects(
        () => accountStore.streams.update(userId, { id: ':_system:language', name: 'Lang' }),
        (err) => { assert.strictEqual(err.id, 'unsupported-operation'); return true; }
      );
    });

    it('[DS1F] rejects stream delete', async () => {
      await assert.rejects(
        () => accountStore.streams.delete(userId, ':_system:language'),
        (err) => { assert.strictEqual(err.id, 'unsupported-operation'); return true; }
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
          assert.strictEqual(err.id, 'unsupported-operation');
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
      await mockStorage.setAccountField(userId, 'email', 'x@y.com', 'test', 1000);
      const history = await accountStore.events.getHistory(userId, 'email');
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].content, 'x@y.com');
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

    it('[DS3J] getHistory has only field stream ID', async () => {
      await mockStorage.setAccountField(userId, 'email', 'a@b.com', 'test', 1000);
      const history = await accountStore.events.getHistory(userId, 'email');
      assert.strictEqual(history.length, 1);
      assert.deepStrictEqual(history[0].streamIds, [':system:email']);
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
