/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleIncomingRevoke tests.
 *
 * [CMCIR] the local bookkeeping that runs when a peer's consent/revoke-cmc is
 * received: clear the withdrawing subject from an open-link capability's
 * acceptedBy so they can re-consent through the same link. Local-only; the
 * handler issues no outbound calls.
 */

const assert = require('node:assert/strict');
const { handleIncomingRevoke } = require('../src/handleIncomingRevoke.ts');

function fakeMall () {
  const accessesById = new Map();
  const eventsById = new Map();
  const calls = { accessesUpdated: [] };
  return {
    calls,
    accessesById,
    eventsById,
    accesses: {
      async get () { return [...accessesById.values()]; },
      async update (userId, params) {
        const ex = accessesById.get(params.id);
        const up = { ...ex, ...(params.update || {}) };
        accessesById.set(params.id, up);
        calls.accessesUpdated.push({ id: params.id, update: params.update });
        return up;
      },
    },
    events: {
      async get (userId, params) {
        if (params && params.id) {
          const e = eventsById.get(params.id);
          return e ? [e] : [];
        }
        return [...eventsById.values()];
      },
    },
  };
}

function seedCapability (mall, capId, acceptedBy) {
  mall.accessesById.set('cap-acc', {
    id: 'cap-acc',
    clientData: { cmc: { kind: 'capability', capabilityId: capId, capability: { mode: 'open-link', state: 'open', stateChangedAt: 1, acceptedBy } } },
  });
}
function seedBackChannel (mall, id, cmc) {
  mall.accessesById.set(id, { id, clientData: { cmc: { role: 'counterparty', ...cmc } } });
}
function acceptedByOf (mall, capId) {
  for (const acc of mall.accessesById.values()) {
    if (acc.clientData?.cmc?.kind === 'capability' && acc.clientData.cmc.capabilityId === capId) {
      return acc.clientData.cmc.capability.acceptedBy || [];
    }
  }
  return null;
}
const SUBJECT = { username: 'alice', host: 'a.example.com' };

describe('[CMCIR] cmc/handleIncomingRevoke', () => {
  it('[CIR1] clears the accepter resolved from the createdBy access (stamped capabilityId)', async () => {
    const mall = fakeMall();
    seedCapability(mall, 'cap-1', [{ ...SUBJECT, acceptedAt: 6000 }, { username: 'bob', host: 'b.example.com', acceptedAt: 6000 }]);
    seedBackChannel(mall, 'bc-1', { capabilityId: 'cap-1', counterparty: SUBJECT });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-1', content: {} },
      deps: { mall },
    });
    assert.equal(res.ok, true);
    assert.equal(res.cleared, true);
    const list = acceptedByOf(mall, 'cap-1');
    assert.equal(list.length, 1);
    assert.equal(list[0].username, 'bob');
  });

  it('[CIR2] resolves the access id from a "<accessId> <callerId>" createdBy', async () => {
    const mall = fakeMall();
    seedCapability(mall, 'cap-2', [{ ...SUBJECT, acceptedAt: 6000 }]);
    seedBackChannel(mall, 'bc-2', { capabilityId: 'cap-2', counterparty: SUBJECT });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-2 caller-xyz', content: {} },
      deps: { mall },
    });
    assert.equal(res.cleared, true);
    assert.equal(acceptedByOf(mall, 'cap-2').length, 0);
  });

  it('[CIR3] legacy bridge: recovers capabilityId from content.offerEventId when the access has none', async () => {
    const mall = fakeMall();
    seedCapability(mall, 'cap-3', [{ ...SUBJECT, acceptedAt: 6000 }]);
    // back-channel access WITHOUT capabilityId (pre-stamp relationship)
    seedBackChannel(mall, 'bc-3', { counterparty: SUBJECT });
    mall.eventsById.set('offer-3', { id: 'offer-3', type: 'consent/request-cmc', content: { capabilityId: 'cap-3' } });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-3', content: { offerEventId: 'offer-3' } },
      deps: { mall },
    });
    assert.equal(res.cleared, true);
    assert.equal(acceptedByOf(mall, 'cap-3').length, 0);
  });

  it('[CIR4] unresolvable capability → no-op success, no throw, no write', async () => {
    const mall = fakeMall();
    seedCapability(mall, 'cap-4', [{ ...SUBJECT, acceptedAt: 6000 }]);
    seedBackChannel(mall, 'bc-4', { counterparty: SUBJECT }); // no capabilityId, no offer
    const updatesBefore = mall.calls.accessesUpdated.length;
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-4', content: {} },
      deps: { mall },
    });
    assert.equal(res.ok, true);
    assert.equal(res.cleared, false);
    assert.equal(res.reason, 'no-capability');
    assert.equal(mall.calls.accessesUpdated.length, updatesBefore);
  });

  it('[CIR5] createdBy access is not a counterparty access → no-op', async () => {
    const mall = fakeMall();
    seedCapability(mall, 'cap-5', [{ ...SUBJECT, acceptedAt: 6000 }]);
    mall.accessesById.set('plain', { id: 'plain', clientData: { cmc: { kind: 'capability' } } });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'plain', content: {} },
      deps: { mall },
    });
    assert.equal(res.cleared, false);
    assert.equal(res.reason, 'not-counterparty-access');
    assert.equal(acceptedByOf(mall, 'cap-5').length, 1);
  });

  it('[CIR6] missing createdBy → no-op', async () => {
    const mall = fakeMall();
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', content: {} },
      deps: { mall },
    });
    assert.equal(res.ok, true);
    assert.equal(res.cleared, false);
    assert.equal(res.reason, 'no-created-by');
  });

  it('[CIR7] issues no outbound calls (loop-safe): fake fetch is never touched', async () => {
    const mall = fakeMall();
    seedCapability(mall, 'cap-7', [{ ...SUBJECT, acceptedAt: 6000 }]);
    seedBackChannel(mall, 'bc-7', { capabilityId: 'cap-7', counterparty: SUBJECT });
    let fetchCalls = 0;
    const fetch = () => { fetchCalls++; throw new Error('handleIncomingRevoke must not POST'); };
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-7', content: {} },
      deps: { mall, fetch },
    });
    assert.equal(res.cleared, true);
    assert.equal(fetchCalls, 0);
  });
});
