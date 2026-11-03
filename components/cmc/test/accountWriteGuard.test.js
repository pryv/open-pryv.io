/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin: no write for an account that is gone.
 *
 * [CMCWG] covers guardAccountWrites (creates and updates refused for an
 * account that is not active, everything else passed through) and the
 * dispatch of an accept whose account is erased while the offer is read: no
 * retry record, no status stamp, no grant, no delivery, no warning.
 */

const assert = require('node:assert/strict');
const { guardAccountWrites, isAccountGoneError, AccountGoneError } = require('../src/accountWriteGuard.ts');
const dispatchMod = require('../src/dispatch.ts');
const { fakeUpdateWithMerge } = require('./_fake-assertions.cjs');

const SECRET = 'cap-token-never-logged';

function recordingLogger () {
  const lines = { info: [], warn: [], debug: [] };
  return {
    lines,
    info: (msg, data) => lines.info.push({ msg, data }),
    warn: (msg, data) => lines.warn.push({ msg, data }),
    debug: (msg, data) => lines.debug.push({ msg, data }),
  };
}

// A group written as a class with a private field: the guard must call the
// methods on the group itself, not on its proxy.
class FakeEvents {
  #rows = new Map();
  calls = [];
  async create (userId, event) { this.calls.push(['create', userId]); const row = { id: 'e' + (this.#rows.size + 1), ...event }; this.#rows.set(row.id, row); return row; }
  async update (userId, event) { this.calls.push(['update', userId]); this.#rows.set(event.id, event); return event; }
  async updateWithMerge (userId, id, merge) { this.calls.push(['updateWithMerge', userId]); const next = merge(this.#rows.get(id)); this.#rows.set(id, next); return next; }
  async get (userId) { this.calls.push(['get', userId]); return [...this.#rows.values()]; }
  async getOne (userId, id) { this.calls.push(['getOne', userId]); return this.#rows.get(id) ?? null; }
  async delete (userId, event) { this.calls.push(['delete', userId]); this.#rows.delete(event.id); }
}

function fakeGroups () {
  const calls = [];
  const plain = (name) => ({
    async create (userId, params) { calls.push([name + '.create', userId]); return { id: name + '-1', ...params }; },
    async update (userId, params) { calls.push([name + '.update', userId]); return params; },
    async get (userId) { calls.push([name + '.get', userId]); return []; },
    async delete (userId) { calls.push([name + '.delete', userId]); return null; },
  });
  return { calls, accesses: plain('accesses'), streams: plain('streams') };
}

describe('[CMCWG] cmc account write guard', () => {
  describe('[CMCWG-G] guardAccountWrites', () => {
    it('[WG01] writes for an active account reach the mall, with the group as `this`', async () => {
      const events = new FakeEvents();
      const { accesses, streams } = fakeGroups();
      const guarded = guardAccountWrites({ events, accesses, streams }, { accountActive: async () => true });
      const created = await guarded.events.create('u1', { type: 'note/txt', streamIds: ['s'], content: 'x' });
      await guarded.events.update('u1', { ...created, content: 'y' });
      const merged = await guarded.events.updateWithMerge('u1', created.id, (row) => ({ ...row, content: 'z' }));
      assert.equal(merged.content, 'z');
      assert.equal((await guarded.events.getOne('u1', created.id)).content, 'z');
      assert.deepEqual(events.calls.map((c) => c[0]), ['create', 'update', 'updateWithMerge', 'getOne']);
      assert.equal((await guarded.accesses.create('u1', { type: 'shared' })).id, 'accesses-1');
      assert.equal((await guarded.streams.create('u1', { id: 's2' })).id, 's2');
    });

    it('[WG02] every create and update for an account that is gone is refused, logged without its content, and never reaches the mall', async () => {
      const events = new FakeEvents();
      const groups = fakeGroups();
      const logger = recordingLogger();
      const guarded = guardAccountWrites({ events, accesses: groups.accesses, streams: groups.streams }, { accountActive: async () => false, logger });
      const content = { capabilityUrl: 'https://' + SECRET + '@peer.example.com/' };
      const attempts = [
        () => guarded.events.create('u1', { type: 'cmc-internal/retry-cmc', streamIds: [':_cmc:_internal:retries'], content }),
        () => guarded.events.update('u1', { id: 'e1', type: 'consent/accept-cmc', content }),
        () => guarded.events.updateWithMerge('u1', 'e1', () => ({ id: 'e1', content })),
        () => guarded.accesses.create('u1', { type: 'shared', name: 'grant', token: SECRET }),
        () => guarded.accesses.update('u1', { id: 'a1', update: { clientData: { secret: SECRET } } }),
        () => guarded.streams.create('u1', { id: ':_cmc:apps:x:chats', name: 'chats' }),
        () => guarded.streams.update('u1', { id: ':_cmc:apps:x:chats', trashed: false }),
      ];
      for (const attempt of attempts) {
        await assert.rejects(attempt, (err) => err instanceof AccountGoneError && isAccountGoneError(err));
      }
      assert.deepEqual(events.calls, []);
      assert.deepEqual(groups.calls, []);
      assert.equal(logger.lines.info.length, attempts.length);
      assert.deepEqual(logger.lines.info.map((l) => l.data.operation), [
        'events.create', 'events.update', 'events.updateWithMerge', 'accesses.create', 'accesses.update', 'streams.create', 'streams.update',
      ]);
      assert.deepEqual(logger.lines.info[0].data, { userId: 'u1', operation: 'events.create', type: 'cmc-internal/retry-cmc', streamIds: [':_cmc:_internal:retries'] });
      assert.deepEqual(logger.lines.info[2].data, { userId: 'u1', operation: 'events.updateWithMerge', id: 'e1' });
      assert.ok(!JSON.stringify(logger.lines).includes(SECRET), 'a credential reached the log');
    });

    it('[WG03] reads and deletes pass through without a check', async () => {
      const events = new FakeEvents();
      const groups = fakeGroups();
      let checks = 0;
      const guarded = guardAccountWrites({ events, accesses: groups.accesses, streams: groups.streams }, { accountActive: async () => { checks += 1; return false; } });
      await guarded.events.get('u1', {});
      await guarded.events.getOne('u1', 'e1');
      await guarded.events.delete('u1', { id: 'e1' });
      await guarded.accesses.get('u1', {});
      await guarded.accesses.delete('u1', { id: 'a1' });
      await guarded.streams.delete('u1', 's');
      assert.equal(checks, 0);
      assert.deepEqual(events.calls.map((c) => c[0]), ['get', 'getOne', 'delete']);
      assert.equal(groups.calls.length, 3);
    });

    it('[WG04] a check that fails rejects with its own error and writes nothing', async () => {
      const events = new FakeEvents();
      const guarded = guardAccountWrites({ events }, { accountActive: async () => { throw new Error('index unavailable'); } });
      await assert.rejects(() => guarded.events.create('u1', { type: 'note/txt' }), (err) => err.message === 'index unavailable' && !isAccountGoneError(err));
      assert.deepEqual(events.calls, []);
    });

    it('[WG05] the guard holds through the spread copies the plugin makes of a mall and of its groups', async () => {
      const events = new FakeEvents();
      const groups = fakeGroups();
      const composed = {
        get events () { return events; },
        get streams () { return groups.streams; },
        accesses: groups.accesses,
      };
      const guarded = guardAccountWrites(composed, { accountActive: async () => false });
      const copy = { ...guarded, accesses: { ...guarded.accesses, getOne: async () => null } };
      await assert.rejects(() => copy.events.create('u1', {}), isAccountGoneError);
      await assert.rejects(() => copy.accesses.create('u1', {}), isAccountGoneError);
      await assert.rejects(() => copy.streams.create('u1', { id: 's' }), isAccountGoneError);
      assert.equal(guarded.events, guarded.events, 'one guarded group per group');
      assert.deepEqual(events.calls, []);
      assert.deepEqual(groups.calls, []);
    });

    it('[WG06] a mall without some groups or methods keeps them absent', async () => {
      const events = new FakeEvents();
      const guarded = guardAccountWrites({ events }, { accountActive: async () => true });
      assert.equal(guarded.accesses, undefined);
      assert.equal(guarded.events.notAMethod, undefined);
    });
  });

  describe('[CMCWG-D] dispatch of an accept whose account is erased during the offer read', () => {
    before(async () => {
      require('test-helpers/src/api-server-tests-config.ts');
      await require('business/src/system-streams/index.ts').init();
    });

    const OFFER = {
      id: 'evt-offer',
      type: 'consent/request-cmc',
      content: {
        request: { title: { en: 't' }, description: { en: 'd' }, consent: { en: 'c' }, permissions: [{ streamId: 'fertility', level: 'read' }] },
        requesterMeta: { username: 'provider-a', appId: 'example-app' },
        capabilityId: 'cap-x',
      },
    };

    function storeMall () {
      const rows = new Map();
      const calls = [];
      const mall = {
        seed (event) { rows.set(event.id, structuredClone(event)); },
        events: {
          async create (userId, params) { calls.push(['events.create', params.type]); return { id: 'r' + calls.length, ...params }; },
          async update (userId, params) { calls.push(['events.update', params.content?.status]); rows.set(params.id, structuredClone(params)); },
          async getOne (userId, id) { return rows.get(id) ?? null; },
          async updateWithMerge (userId, id, merge, transaction, opts) { return fakeUpdateWithMerge(this, userId, id, merge, transaction, opts); },
        },
        accesses: {
          async create (userId, params) { calls.push(['accesses.create', params.type]); return { id: 'acc-1', apiEndpoint: 'https://tok@alice.example.com/', ...params }; },
          async delete (userId, params) { calls.push(['accesses.delete', params.id]); },
        },
        streams: { async create (userId, params) { calls.push(['streams.create', params.id]); return params; } },
      };
      return { mall, calls };
    }

    for (const [code, answer] of [['WG07', 'not-found'], ['WG08', 'offer']]) {
      it('[' + code + '] the offer read answers ' + answer + ' after the erasure: nothing is written, nothing is delivered, the drops are logged at info', async () => {
        const { mall, calls } = storeMall();
        let active = true;
        const logger = recordingLogger();
        const fetches = [];
        const fetch = async (url, init) => {
          fetches.push((init?.method ?? 'GET') + ' ' + url);
          active = false; // the account is erased while the read is in flight
          const status = answer === 'offer' ? 200 : 404;
          const body = answer === 'offer' ? { events: [OFFER] } : { error: { id: 'unknown-resource' } };
          return { status, ok: status === 200, async json () { return body; }, async text () { return JSON.stringify(body); } };
        };
        const guarded = guardAccountWrites(mall, { accountActive: async () => active, logger });
        const event = { id: 'evt-accept', type: 'consent/accept-cmc', streamIds: [':_cmc:apps:example-app'], content: { capabilityUrl: 'https://' + SECRET + '@peer.example.com/' } };
        mall.seed(event);
        const r = await dispatchMod.dispatch({
          userId: 'u1',
          event,
          deps: { mall: guarded, fetch, selfIdentityFor: () => ({ username: 'alice', host: 'alice.example.com' }), logger, enqueueRetries: true },
        });
        assert.equal(r.status, 'failed');
        // Only the 'delivered' stamp, written before the erasure.
        assert.deepEqual(calls, [['events.update', 'delivered']]);
        assert.equal(fetches.length, 1, 'only the offer read: ' + JSON.stringify(fetches.map((f) => f.split(' ')[0])));
        // The dispatch loop reports the dropped writes at info (a handler may
        // still warn about its own step, e.g. the anchor streams).
        assert.deepEqual(logger.lines.warn.filter((l) => l.msg.startsWith('cmc/dispatch')).map((l) => l.msg), []);
        assert.ok(logger.lines.info.some((l) => l.msg.startsWith('cmc/dispatch: failed to enqueue retry') && l.data.eventId === 'evt-accept'), JSON.stringify(logger.lines.info));
        assert.ok(logger.lines.info.some((l) => l.msg.startsWith('cmc/dispatch: failed to mark trigger as failed') && l.data.eventId === 'evt-accept'));
        assert.ok(!JSON.stringify(logger.lines).includes(SECRET), 'a credential reached the log');
      });
    }
  });
});
