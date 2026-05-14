/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — orchestration dispatch loop tests.
 *
 * [CMCDISP] covers dispatch() + createDispatchMiddleware() against fake
 * mall + fetch.
 */

const assert = require('node:assert/strict');
const { dispatch, createDispatchMiddleware } = require('../src/dispatch.ts');

function fakeMall () {
  const calls = { eventsUpdated: [], accessesCreated: [], accessesDeleted: [] };
  return {
    calls,
    accesses: {
      async create (userId, params) {
        calls.accessesCreated.push({ userId, ...params });
        return {
          id: 'acc-' + (calls.accessesCreated.length),
          token: 'tok',
          apiEndpoint: 'https://tok-grant@recipient.example.com/',
          ...params,
        };
      },
      async delete (userId, params) { calls.accessesDeleted.push({ userId, ...params }); },
    },
    events: {
      async update (userId, params) { calls.eventsUpdated.push({ userId, ...params }); },
      async create () { return { event: { id: 'ne' } }; },
    },
    streams: {
      async create () { return { id: 's' }; },
    },
  };
}

function fakeFetch (responses) {
  const calls = [];
  let idx = 0;
  return {
    fetch (url, init) {
      calls.push({ url, init });
      const spec = Array.isArray(responses) ? responses[idx++] : responses;
      if (spec instanceof Error) return Promise.reject(spec);
      return Promise.resolve({
        status: spec.status,
        ok: spec.status >= 200 && spec.status < 300,
        async json () { return spec.body; },
        async text () { return JSON.stringify(spec.body); },
      });
    },
    calls,
  };
}

const SELF = { username: 'alice', host: 'recipient.example.com' };
const VALID_OFFER = {
  id: 'evt-offer',
  type: 'cmc/request-v1',
  content: {
    request: {
      title: { en: 'Example' },
      description: { en: 'desc' },
      consent: { en: 'I agree' },
      permissions: [{ streamId: 'fertility', level: 'read' }],
    },
    requesterMeta: { username: 'provider-a', appId: 'example-app' },
    capabilityId: 'cap-x',
  },
};

describe('[CMCDISP] cmc/dispatch', () => {
  describe('[CMCDISP-D] dispatch() type-routing', () => {
    it('[CD01] skips events without a cmc/ type prefix', async () => {
      const r = await dispatch({
        userId: 'u1',
        event: { id: 'e1', type: 'note/txt', content: 'x' },
        deps: makeDeps({}),
      });
      assert.equal(r.handled, false);
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'not-cmc-event');
    });

    it('[CD02] skips cmc/request-v1 (handled by capability-mint hook elsewhere)', async () => {
      const r = await dispatch({
        userId: 'u1',
        event: { id: 'e1', type: 'cmc/request-v1', content: { capabilityRequested: true } },
        deps: makeDeps({}),
      });
      assert.equal(r.handled, false);
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'request-handled-elsewhere');
    });

    it('[CD03] returns delivered for unimplemented types (chat / system / revoke)', async () => {
      for (const type of ['cmc/chat-v1', 'cmc/revoke-v1', 'cmc/system-alert-v1']) {
        const r = await dispatch({
          userId: 'u1',
          event: { id: 'e1', type, content: {} },
          deps: makeDeps({}),
        });
        assert.equal(r.handled, false);
        assert.equal(r.status, 'delivered');
      }
    });
  });

  describe('[CMCDISP-A] dispatch routes cmc/accept-v1 → handleAccept', () => {
    it('[CD04] happy path: stamps delivered then completed', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-accept',
          type: 'cmc/accept-v1',
          content: { capabilityUrl: 'https://Tok@example.com/' },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.handled, true);
      assert.equal(r.status, 'completed');
      // Mall: 2 events.update — one to 'delivered', one to 'completed'
      assert.equal(mall.calls.eventsUpdated.length, 2);
      assert.equal(mall.calls.eventsUpdated[0].update.content.status, 'delivered');
      assert.equal(mall.calls.eventsUpdated[1].update.content.status, 'completed');
      assert.equal(mall.calls.eventsUpdated[1].update.content.dataGrantAccessId, 'acc-1');
    });

    it('[CD05] failed delivery → stamps failed with reason + detail', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 400, body: { error: 'bad' } }, // 4xx delivery → handler rolls back
      ]);
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-accept',
          type: 'cmc/accept-v1',
          content: { capabilityUrl: 'https://Tok@example.com/' },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.handled, true);
      assert.equal(r.status, 'failed');
      assert.equal(r.reason, 'cmc-handler-delivery-rejected');
      const updates = mall.calls.eventsUpdated;
      assert.equal(updates[updates.length - 1].update.content.status, 'failed');
      assert.equal(updates[updates.length - 1].update.content.failure.reason, 'cmc-handler-delivery-rejected');
      // Rollback triggered
      assert.equal(mall.calls.accessesDeleted.length, 1);
    });

    it('[CD06] handler throws → caught and surfaced as failed', async () => {
      const mall = fakeMall();
      mall.accesses.create = async () => { throw new Error('mall-down'); };
      const { fetch } = fakeFetch([{ status: 200, body: { events: [VALID_OFFER] } }]);
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-accept',
          type: 'cmc/accept-v1',
          content: { capabilityUrl: 'https://Tok@example.com/' },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.status, 'failed');
      assert.equal(r.reason, 'cmc-handler-data-grant-create-failed');
    });
  });

  describe('[CMCDISP-R] dispatch routes cmc/refuse-v1 → handleRefuse', () => {
    it('[CD07] happy path: refuse completes', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-refuse',
          type: 'cmc/refuse-v1',
          content: { capabilityUrl: 'https://Tok@example.com/', reason: { en: 'no' } },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.status, 'completed');
    });
  });

  describe('[CMCDISP-MW] createDispatchMiddleware (fire-and-forget)', () => {
    it('[CD08] kicks off dispatch without awaiting; calls next() immediately', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const mw = createDispatchMiddleware(makeDeps({ mall, fetch }));
      let nextCalled = false;
      mw(
        { user: { id: 'u1' } },
        {},
        { event: { id: 'evt-refuse', type: 'cmc/refuse-v1', content: { capabilityUrl: 'https://Tok@example.com/' } } },
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, true);
      // Wait for the async dispatch to settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Should have stamped delivered + completed
      assert.ok(mall.calls.eventsUpdated.length >= 1);
    });

    it('[CD09] passes through non-cmc events without firing dispatch', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const mw = createDispatchMiddleware(makeDeps({ mall, fetch }));
      let nextCalled = false;
      mw(
        { user: { id: 'u1' } },
        {},
        { event: { id: 'e1', type: 'note/txt', content: 'x' } },
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(mall.calls.eventsUpdated.length, 0);
    });
  });
});

function makeDeps ({ mall, fetch }) {
  return {
    mall: mall || fakeMall(),
    fetch: fetch || fakeFetch({ status: 200, body: {} }).fetch,
    selfIdentityFor: () => SELF,
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
  };
}
