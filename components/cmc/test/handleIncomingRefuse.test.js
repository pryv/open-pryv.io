/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [CMCIRF] requester side of a refusal delivered through the capability URL.
 */

const assert = require('node:assert/strict');
const { handleIncomingRefuse } = require('../src/handleIncomingRefuse.ts');

function fakeMall ({ mode, withGetOne = true } = {}) {
  const capability = {
    id: 'cap-acc',
    clientData: {
      cmc: { kind: 'capability', capabilityId: 'cap-1', requestEventId: 'inv-1', capability: { mode: mode || 'single-use', state: 'open' } },
    },
  };
  const invite = { id: 'inv-1', type: 'consent/request-cmc', content: { status: 'delivered', ...(mode ? { capability: { mode } } : {}) } };
  const calls = { gets: 0, accessesUpdated: 0, eventsUpdated: 0 };
  const mall = {
    calls,
    capability,
    invite,
    accesses: {
      async get () { calls.gets++; return [capability]; },
      async update () { calls.accessesUpdated++; },
    },
    events: {
      async getOne (userId, id) { return id === invite.id ? invite : null; },
      async update (userId, event) { calls.eventsUpdated++; Object.assign(invite, event); return event; },
    },
  };
  if (withGetOne) mall.accesses.getOne = async (userId, { id }) => (id === capability.id ? capability : null);
  return mall;
}

function refuse (content = {}, createdBy = 'cap-acc') {
  return {
    id: 'evt-refuse',
    type: 'consent/refuse-cmc',
    streamIds: [':_cmc:_internal:responses:cap-1'],
    createdBy,
    content: { from: { username: 'bob', host: 'b.example.com' }, capabilityId: 'cap-1', capabilityUrl: 'https://example.com/', ...content },
  };
}

describe('[CMCIRF] cmc/handleIncomingRefuse', () => {
  it('[IR01] single-use: marks the invite refused with who, when and why, reading the capability by id', async () => {
    const mall = fakeMall();
    const res = await handleIncomingRefuse({ userId: 'u1', event: refuse({ reason: { en: 'no' } }), deps: { mall } });
    assert.deepEqual(res, { ok: true, capabilityId: 'cap-1', inviteRefused: true });
    assert.equal(mall.invite.content.status, 'refused');
    assert.deepEqual(mall.invite.content.refusedBy, { username: 'bob', host: 'b.example.com' });
    assert.equal(typeof mall.invite.content.refusedAt, 'number');
    assert.deepEqual(mall.invite.content.reason, { en: 'no' });
    assert.equal(mall.calls.gets, 0, 'capability read by id from createdBy');
  });

  it('[IR02] open-link: ok, the invite is untouched', async () => {
    const mall = fakeMall({ mode: 'open-link' });
    const res = await handleIncomingRefuse({ userId: 'u1', event: refuse(), deps: { mall } });
    assert.deepEqual(res, { ok: true, capabilityId: 'cap-1', inviteRefused: false });
    assert.equal(mall.calls.eventsUpdated, 0);
  });

  it('[IR03] a refuse without capabilityId fails', async () => {
    const mall = fakeMall();
    const res = await handleIncomingRefuse({ userId: 'u1', event: refuse({ capabilityId: undefined }), deps: { mall } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'cmc-incoming-refuse-missing-capability-id');
  });

  it('[IR04] an unknown capability fails with capability-access-not-found', async () => {
    const mall = fakeMall();
    const res = await handleIncomingRefuse({
      userId: 'u1', event: refuse({ capabilityId: 'cap-unknown' }, 'nobody caller-1'), deps: { mall },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'capability-access-not-found');
  });

  it('[IR06] a refusedBy that is not a username/host pair is recorded as null', async () => {
    const mall = fakeMall();
    await handleIncomingRefuse({ userId: 'u1', event: refuse({ from: { username: { $ne: 1 }, host: 7 } }), deps: { mall } });
    assert.equal(mall.invite.content.status, 'refused');
    assert.equal(mall.invite.content.refusedBy, null);
  });

  it('[IR05] a refusal does not consume the link: the capability access is not written', async () => {
    const mall = fakeMall({ withGetOne: false });
    await handleIncomingRefuse({ userId: 'u1', event: refuse(), deps: { mall } });
    assert.equal(mall.calls.accessesUpdated, 0);
    assert.equal(mall.capability.clientData.cmc.capability.state, 'open');
  });
});
