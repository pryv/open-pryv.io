/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global assert, initTests, initCore, getNewFixture, charlatan, cuid, coreRequest */

require('test-helpers/src/api-server-tests-config.ts');

describe('[CQAC] events.get content/clientData query conditions', () => {
  let user, username, fixtures, personalToken, eventsPath;
  const eventIds = {};

  before(async () => {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    user = await fixtures.user(charlatan.Lorem.characters(7), {});
    username = user.attrs.username;
    const access = await user.access({ type: 'personal', token: cuid() });
    personalToken = access.attrs.token;
    await user.session(personalToken);
    await user.stream({ id: 'medication', name: 'Medication' });
    await user.stream({ id: 'lab-results', name: 'Lab results' });

    const assertions = [
      ['progesterone', { drug: { label: 'Progesterone', codes: { atc: 'G03DA04' } }, taken: true, scope: 2 }, null],
      ['aspirin', { drug: { label: 'Aspirin', codes: { atc: 'B01AC06' } }, taken: false }, { 'ehr-sync': { externalId: 'obs-78421' } }],
      ['paracetamol', { drug: { label: 'Paracetamol', codes: { atc: 'N02BE01' } }, taken: 1 }, null] // taken: 1 — not boolean
    ];
    let time = 1700000000;
    for (const [key, content, clientData] of assertions) {
      const attrs = {
        type: 'medication/exposure-assertion-v1',
        streamIds: ['medication'],
        content,
        time: time++
      };
      if (clientData != null) attrs.clientData = clientData;
      const e = await user.event(attrs);
      eventIds[key] = e.attrs.id;
    }
    const scalar = await user.event({
      type: 'measure/num-v1',
      streamIds: ['lab-results'],
      content: 14.2,
      time: time++
    });
    eventIds.scalar = scalar.attrs.id;

    eventsPath = '/' + username + '/events/';
  });

  after(async () => {
    await fixtures.clean();
  });

  function getEvents (query) {
    return coreRequest.get(eventsPath).set('Authorization', personalToken).query(query);
  }
  function idsOf (res) {
    return res.body.events.map((e) => e.id).sort();
  }

  it('[CQ01] filters by eq on a nested content path', async () => {
    const res = await getEvents({ content: JSON.stringify([{ path: 'drug.codes.atc', eq: 'G03DA04' }]) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(idsOf(res), [eventIds.progesterone]);
  });

  it('[CQ02] applies strict JSON types (eq true does not match 1)', async () => {
    const res = await getEvents({ content: JSON.stringify([{ path: 'taken', eq: true }]) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(idsOf(res), [eventIds.progesterone]);
  });

  it('[CQ03] combines in + eq conditions (AND) with streams + types', async () => {
    const res = await getEvents({
      streams: JSON.stringify(['medication']),
      types: ['medication/exposure-assertion-v1'],
      content: JSON.stringify([
        { path: 'drug.codes.atc', in: ['G03DA04', 'B01AC06', 'N02BE01'] },
        { path: 'taken', eq: false }
      ])
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(idsOf(res), [eventIds.aspirin]);
  });

  it('[CQ04] filters by prefix (hierarchical codes)', async () => {
    const res = await getEvents({ content: JSON.stringify([{ path: 'drug.codes.atc', prefix: 'G03' }]) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(idsOf(res), [eventIds.progesterone]);
  });

  it('[CQ05] addresses scalar content with the root path $', async () => {
    const res = await getEvents({ content: JSON.stringify([{ path: '$', gte: 12 }]) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(idsOf(res), [eventIds.scalar]);
  });

  it('[CQ06] filters by clientData conditions', async () => {
    const res = await getEvents({ clientData: JSON.stringify([{ path: 'ehr-sync.externalId', eq: 'obs-78421' }]) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(idsOf(res), [eventIds.aspirin]);
  });

  it('[CQ07] exists / neq honor missing-path semantics', async () => {
    const res = await getEvents({ content: JSON.stringify([{ path: 'scope', exists: false }, { path: 'drug.label', neq: 'Aspirin' }]) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(idsOf(res), [eventIds.paracetamol]);
  });

  it('[CQ08] rejects malformed conditions with invalid-parameters-format', async () => {
    const res = await getEvents({ content: JSON.stringify([{ path: 'drug..codes', eq: 'x' }]) });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
    assert.match(res.body.error.message, /condition #1/);
  });

  it('[CQ09] rejects content conditions on a store that does not support them', async () => {
    const res = await getEvents({
      streams: JSON.stringify([':dummy:antonia']),
      content: JSON.stringify([{ path: 'id', eq: 'antonia' }])
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.id, 'invalid-operation');
  });
});
