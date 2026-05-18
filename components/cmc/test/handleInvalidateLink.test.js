/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleInvalidateLink (Phase 2 capability lifecycle).
 *
 * [CMCIL] covers the requester-side `consent/invalidate-link-cmc`
 * handler: open-link state flip + idempotency + single-use no-op +
 * missing/unknown capabilityId surfaces.
 */

const assert = require('node:assert/strict');
const { mintCapability } = require('../src/capability.ts');
const { handleInvalidateLink } = require('../src/handleInvalidateLink.ts');

function fakeMall () {
  const calls = { streamsCreated: [], eventsCreated: [], accessesCreated: [], accessesUpdated: [] };
  const accessesById = new Map();
  let nextAccessIdx = 0;
  return {
    calls,
    accessesById,
    streams: {
      async create (userId, params) {
        calls.streamsCreated.push({ userId, ...params });
        return { id: params.id };
      },
    },
    events: {
      async create (userId, params) {
        calls.eventsCreated.push({ userId, ...params });
        return { event: { id: 'evt-' + calls.eventsCreated.length, ...params } };
      },
    },
    accesses: {
      async create (userId, params) {
        const id = 'acc-' + (++nextAccessIdx);
        const access = {
          id,
          token: 'tok-' + id,
          apiEndpoint: 'https://tok-' + id + '@example.com/',
          ...params,
        };
        accessesById.set(id, access);
        calls.accessesCreated.push({ userId, ...params, id });
        return access;
      },
      async get (_userId, _params) {
        return Array.from(accessesById.values());
      },
      async update (_userId, params) {
        const existing = accessesById.get(params.id);
        if (existing == null) throw new Error('no access ' + params.id);
        const updated = { ...existing, ...(params.update || {}) };
        accessesById.set(params.id, updated);
        calls.accessesUpdated.push({ id: params.id, update: params.update });
        return updated;
      },
    },
  };
}

const OPEN_LINK_TRIGGER = {
  id: 'evt-trigger-il-ol',
  type: 'consent/request-cmc',
  content: {
    to: null,
    capabilityRequested: true,
    capability: { mode: 'open-link' },
    request: {
      title: { en: 't' },
      description: { en: 'd' },
      consent: { en: 'c' },
      permissions: [{ streamId: 's', level: 'read' }],
    },
  },
};

const SINGLE_USE_TRIGGER = {
  id: 'evt-trigger-il-su',
  type: 'consent/request-cmc',
  content: {
    to: null,
    capabilityRequested: true,
    request: {
      title: { en: 't' },
      description: { en: 'd' },
      consent: { en: 'c' },
      permissions: [{ streamId: 's', level: 'read' }],
    },
  },
};

describe('[CMCIL] cmc/handleInvalidateLink', () => {
  it('[CMCIL-A] happy path: open-link capability invalidated → state=invalidated', async () => {
    const mall = fakeMall();
    const r = await mintCapability({
      userId: 'u1',
      triggerEvent: OPEN_LINK_TRIGGER,
      deps: { mall, idGen: () => 'cap-il-a', now: () => 1000 },
    });
    const result = await handleInvalidateLink({
      userId: 'u1',
      triggerEvent: {
        id: 'evt-il-a',
        type: 'consent/invalidate-link-cmc',
        streamIds: [':_cmc:apps:my-app'],
        content: { capabilityId: 'cap-il-a' },
      },
      deps: { mall },
    });
    assert.equal(result.ok, true);
    assert.equal(result.eventType, 'consent/invalidate-link-cmc');
    assert.equal(result.capabilityId, 'cap-il-a');
    const acc = mall.accessesById.get(r.accessId);
    assert.equal(acc.clientData.cmc.capability.state, 'invalidated');
  });

  it('[CMCIL-B] capability not found → returns capability-access-not-found', async () => {
    const mall = fakeMall();
    const result = await handleInvalidateLink({
      userId: 'u1',
      triggerEvent: {
        id: 'evt-il-b',
        type: 'consent/invalidate-link-cmc',
        streamIds: [':_cmc:apps:my-app'],
        content: { capabilityId: 'never-existed' },
      },
      deps: { mall },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'capability-access-not-found');
  });

  it('[CMCIL-C] single-use capability → returns { ok:true, alreadyConsumed:true }', async () => {
    const mall = fakeMall();
    await mintCapability({
      userId: 'u1',
      triggerEvent: SINGLE_USE_TRIGGER,
      deps: { mall, idGen: () => 'cap-il-c', now: () => 1000 },
    });
    const updatesBefore = mall.calls.accessesUpdated.length;
    const result = await handleInvalidateLink({
      userId: 'u1',
      triggerEvent: {
        id: 'evt-il-c',
        type: 'consent/invalidate-link-cmc',
        streamIds: [':_cmc:apps:my-app'],
        content: { capabilityId: 'cap-il-c' },
      },
      deps: { mall },
    });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyConsumed, true);
    // No mutation on single-use access.
    assert.equal(mall.calls.accessesUpdated.length, updatesBefore);
  });

  it('[CMCIL-D] missing capabilityId → returns cmc-handler-missing-capability-id', async () => {
    const mall = fakeMall();
    const result = await handleInvalidateLink({
      userId: 'u1',
      triggerEvent: {
        id: 'evt-il-d',
        type: 'consent/invalidate-link-cmc',
        streamIds: [':_cmc:apps:my-app'],
        content: {},
      },
      deps: { mall },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'cmc-handler-missing-capability-id');
  });
});
