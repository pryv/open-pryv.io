/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — capability open-link lifecycle tests.
 *
 * [CMCOL] covers `markCapabilityInvalidated` semantics on top of the
 * mintCapability + state machine. Who joined an open-link invite is read from
 * the relationship accesses: see [CC34]/[CC35] and the handshake suite.
 */

const assert = require('node:assert/strict');
const {
  mintCapability,
  markCapabilityInvalidated,
  findCapabilityAccess,
} = require('../src/capability.ts');

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
  id: 'evt-trigger-ol',
  type: 'consent/request-cmc',
  content: {
    to: null,
    capabilityRequested: true,
    capability: { mode: 'open-link' },
    request: {
      title: { en: 'Multi-patient study invite' },
      description: { en: 'Open-link study' },
      consent: { en: 'I agree.' },
      permissions: [{ streamId: 'symptoms', level: 'read' }],
    },
  },
};

const SINGLE_USE_TRIGGER = {
  id: 'evt-trigger-su',
  type: 'consent/request-cmc',
  content: {
    to: null,
    capabilityRequested: true,
    request: {
      title: { en: 'Single-use invite' },
      description: { en: 'Per-patient' },
      consent: { en: 'I agree.' },
      permissions: [{ streamId: 'symptoms', level: 'read' }],
    },
  },
};

describe('[CMCOL] cmc/capability open-link', () => {
  describe('[CMCOL-MD] markCapabilityInvalidated flips state', () => {
    it('[CMCOL-MD] open access becomes state=invalidated + bumps stateChangedAt', async () => {
      const mall = fakeMall();
      const r = await mintCapability({
        userId: 'u1',
        triggerEvent: OPEN_LINK_TRIGGER,
        deps: { mall, idGen: () => 'cap-ol-md', now: () => 1000 },
      });
      const res = await markCapabilityInvalidated({
        userId: 'u1',
        capabilityId: 'cap-ol-md',
        deps: { mall, now: () => 9000 },
      });
      assert.equal(res.ok, true);
      const acc = mall.accessesById.get(r.accessId);
      assert.equal(acc.clientData.cmc.capability.state, 'invalidated');
      assert.equal(acc.clientData.cmc.capability.stateChangedAt, 9000);
      // Mode is preserved.
      assert.equal(acc.clientData.cmc.capability.mode, 'open-link');
    });
  });

  describe('[CMCOL-ME] markCapabilityInvalidated is idempotent', () => {
    it('[CMCOL-ME] second call on an already-invalidated access is a no-op success', async () => {
      const mall = fakeMall();
      await mintCapability({
        userId: 'u1',
        triggerEvent: OPEN_LINK_TRIGGER,
        deps: { mall, idGen: () => 'cap-ol-me', now: () => 1000 },
      });
      await markCapabilityInvalidated({
        userId: 'u1', capabilityId: 'cap-ol-me', deps: { mall, now: () => 9000 },
      });
      const updatesAfterFirst = mall.calls.accessesUpdated.length;
      const res = await markCapabilityInvalidated({
        userId: 'u1', capabilityId: 'cap-ol-me', deps: { mall, now: () => 9999 },
      });
      assert.equal(res.ok, true);
      assert.equal(mall.calls.accessesUpdated.length, updatesAfterFirst,
        'idempotent — no new update on already-invalidated access');
    });
  });

  describe('[CMCOL-MF] markCapabilityInvalidated tolerates single-use consumed', () => {
    it('[CMCOL-MF] consumed (single-use) access is a no-op success', async () => {
      const mall = fakeMall();
      const r = await mintCapability({
        userId: 'u1',
        triggerEvent: SINGLE_USE_TRIGGER,
        deps: { mall, idGen: () => 'cap-ol-mf', now: () => 1000 },
      });
      // Manually flip to consumed to simulate post-accept state.
      const acc = mall.accessesById.get(r.accessId);
      acc.clientData.cmc.capability.state = 'consumed';
      mall.accessesById.set(r.accessId, acc);
      const updatesBefore = mall.calls.accessesUpdated.length;
      const res = await markCapabilityInvalidated({
        userId: 'u1', capabilityId: 'cap-ol-mf', deps: { mall, now: () => 9999 },
      });
      assert.equal(res.ok, true);
      assert.equal(mall.calls.accessesUpdated.length, updatesBefore,
        'no-op on consumed access');
      const after = await findCapabilityAccess({
        userId: 'u1', capabilityId: 'cap-ol-mf', deps: { mall },
      });
      assert.equal(after.clientData.cmc.capability.state, 'consumed',
        'state must remain "consumed" — invalidate must not overwrite');
    });
  });
});
