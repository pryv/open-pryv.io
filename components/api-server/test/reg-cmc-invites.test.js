/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, assert, cuid */

/**
 * [RCIV] Consent invites in an access request (`cmcInvites`): validated and
 * stored at creation, echoed to the app (201) and to the auth page
 * (NEED_SIGNIN poll); one outcome per invite posted with ACCEPTED, validated
 * before anything is written and served in the ACCEPTED bodies. The core
 * never acts on them.
 */

const accessState = require('../src/routes/reg/accessState.ts');
const { MAX_INVITES } = require('../src/routes/reg/cmcInvites.ts');

describe('[RCIV] consent invites in an access request (cmcInvites)', () => {
  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
  });

  afterEach(async () => {
    await accessState.clear();
  });

  const BODY = { requestingAppId: 'test-app', requestedPermissions: [{ streamId: 'diary', level: 'read' }] };
  const INVITE_A = 'https://cap-a@doctor.example.com/';
  const INVITE_B = 'https://cap-b@study.example.com/';
  const INVITES = [
    { capabilityUrl: INVITE_A, mandatory: true },
    { capabilityUrl: INVITE_B, for: 'target' }
  ];
  const STORED = [
    { capabilityUrl: INVITE_A, mandatory: true, for: 'self' },
    { capabilityUrl: INVITE_B, mandatory: false, for: 'target' }
  ];
  const ACCEPT = {
    status: 'ACCEPTED',
    username: 'alice',
    token: 'alice-app-token',
    apiEndpoint: 'https://alice-app-token@alice.pryv.me/'
  };
  const OUTCOMES = [{ acceptEventId: 'ev-a', dataGrantAccessId: 'grant-a' }, { declined: true }];

  async function create (extra) {
    return await coreRequest.post('/reg/access').send({ ...BODY, ...extra });
  }
  async function newKey (extra) {
    const res = await create(extra);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.key;
  }

  it('[RCI1] the invites are echoed, normalised, on the 201 and on the NEED_SIGNIN poll, only when sent', async () => {
    const res = await create({ cmcInvites: INVITES });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.cmcInvites, STORED);
    const poll = await coreRequest.get('/reg/access/' + res.body.key);
    assert.strictEqual(poll.body.status, 'NEED_SIGNIN');
    assert.deepStrictEqual(poll.body.cmcInvites, STORED);

    for (const extra of [{}, { cmcInvites: null }]) {
      const plain = await create(extra);
      assert.ok(!('cmcInvites' in plain.body), 'absent from the 201: ' + JSON.stringify(extra));
      const plainPoll = await coreRequest.get('/reg/access/' + plain.body.key);
      assert.ok(!('cmcInvites' in plainPoll.body), 'absent from the poll: ' + JSON.stringify(extra));
    }
  });

  it('[RCI2] malformed invites are refused with 400 and nothing is stored', async () => {
    const nine = Array.from({ length: MAX_INVITES + 1 }, (_v, i) => ({ capabilityUrl: 'https://c' + i + '@x.example.com/' }));
    const bad = [
      [], nine, 'https://x.example.com/', { capabilityUrl: INVITE_A },
      [{}], [{ capabilityUrl: 'not a url' }], [{ capabilityUrl: 'ftp://x.example.com/' }],
      [{ capabilityUrl: 'javascript:alert(1)' }], [{ capabilityUrl: 'https://x.example.com/\nevil' }],
      [{ capabilityUrl: 'https://x.example.com/' + 'a'.repeat(2100) }],
      [{ capabilityUrl: INVITE_A, for: 'both' }], [{ capabilityUrl: INVITE_A, mandatory: 'yes' }],
      [{ capabilityUrl: INVITE_A, token: 'leak' }]
    ];
    for (const cmcInvites of bad) {
      const res = await create({ cmcInvites });
      assert.strictEqual(res.status, 400, JSON.stringify(cmcInvites).slice(0, 80));
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
    }
  });

  it('[RCI3] the outcomes are kept and served in the ACCEPTED bodies (POST answer and polls)', async () => {
    const key = await newKey({ cmcInvites: INVITES });
    const post = await coreRequest.post('/reg/access/' + key)
      .send({ ...ACCEPT, cmcInvites: [{ acceptEventId: 'ev-a', dataGrantAccessId: 'grant-a', acceptedFor: 'self' }, { reason: 'cmc-offer-expired' }] });
    assert.strictEqual(post.status, 200, JSON.stringify(post.body));
    const expected = [{ acceptEventId: 'ev-a', dataGrantAccessId: 'grant-a', acceptedFor: 'self' }, { reason: 'cmc-offer-expired' }];
    assert.deepStrictEqual(post.body.cmcInvites, expected);
    const poll = await coreRequest.get('/reg/access/' + key);
    assert.strictEqual(poll.body.status, 'ACCEPTED');
    assert.deepStrictEqual(poll.body.cmcInvites, expected);
    assert.strictEqual(poll.body.token, ACCEPT.token);

    // a request with invites accepted by a page that ignores them: no outcomes, legacy keys only
    const ignored = await newKey({ cmcInvites: INVITES });
    const plain = await coreRequest.post('/reg/access/' + ignored).send(ACCEPT);
    assert.deepStrictEqual(Object.keys(plain.body).sort(), ['apiEndpoint', 'status', 'token', 'username']);
  });

  it('[RCI4] outcomes of the wrong length or shape are refused with 400 and the request stays pending', async () => {
    const key = await newKey({ cmcInvites: INVITES });
    const bad = [
      [OUTCOMES[0]],
      [...OUTCOMES, { declined: true }],
      'yes',
      [OUTCOMES[0], { declined: false }],
      [OUTCOMES[0], { declined: true, reason: 'x' }],
      [{ acceptEventId: '' }, { declined: true }],
      [{ acceptEventId: 'ev', token: 'leak' }, { declined: true }],
      [{ acceptEventId: 'ev', acceptedFor: 'target' }, { declined: true }],
      [{ reason: 'r'.repeat(300) }, { declined: true }],
      [{}, { declined: true }]
    ];
    for (const cmcInvites of bad) {
      const res = await coreRequest.post('/reg/access/' + key).send({ ...ACCEPT, cmcInvites });
      assert.strictEqual(res.status, 400, JSON.stringify(cmcInvites).slice(0, 80));
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
    }
    const poll = await coreRequest.get('/reg/access/' + key);
    assert.strictEqual(poll.body.status, 'NEED_SIGNIN');
    assert.deepStrictEqual(poll.body.cmcInvites, STORED, 'the app\'s invites are unchanged');

    // outcomes on a request that carried no invites
    const plainKey = await newKey();
    const res = await coreRequest.post('/reg/access/' + plainKey).send({ ...ACCEPT, cmcInvites: OUTCOMES });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await coreRequest.get('/reg/access/' + plainKey)).body.status, 'NEED_SIGNIN');
  });

  it('[RCI5] outcomes are refused on a non-ACCEPTED post; a mandatory decline ends REFUSED with its reason id', async () => {
    const key = await newKey({ cmcInvites: INVITES });
    const res = await coreRequest.post('/reg/access/' + key)
      .send({ status: 'REFUSED', reasonId: 'REFUSED_MANDATORY_CONSENT', message: 'declined', cmcInvites: OUTCOMES });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.status, 'NEED_SIGNIN');

    const refused = await coreRequest.post('/reg/access/' + key)
      .send({ status: 'REFUSED', reasonId: 'REFUSED_MANDATORY_CONSENT', message: 'A required consent was declined' });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    const poll = await coreRequest.get('/reg/access/' + key);
    assert.strictEqual(poll.body.status, 'REFUSED');
    assert.strictEqual(poll.body.reasonId, 'REFUSED_MANDATORY_CONSENT');
    assert.ok(!('cmcInvites' in poll.body));
  });

  it('[RCI6] the request size ceiling still applies to invites', async () => {
    const big = Array.from({ length: 8 }, (_v, i) => ({ capabilityUrl: 'https://c' + i + '@x.example.com/' + 'a'.repeat(2000) }));
    const res = await create({ cmcInvites: big, clientData: { note: 'n'.repeat(2000) } });
    assert.strictEqual(res.status, 413, JSON.stringify(res.body).slice(0, 200));
  });

  it('[RCI8] a body naming the stored field (cmcInviteOutcomes) directly is never stored', async () => {
    const forged = [{ acceptEventId: 'forged', extra: 'x' }];
    // with request invites, without outcomes
    const k1 = await newKey({ cmcInvites: INVITES });
    const r1 = await coreRequest.post('/reg/access/' + k1).send({ ...ACCEPT, cmcInviteOutcomes: forged });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    assert.ok(!('cmcInvites' in r1.body), JSON.stringify(r1.body));
    // with request invites, valid outcomes beside a forged stored field
    const k2 = await newKey({ cmcInvites: INVITES });
    const r2 = await coreRequest.post('/reg/access/' + k2).send({ ...ACCEPT, cmcInvites: OUTCOMES, cmcInviteOutcomes: forged });
    assert.deepStrictEqual(r2.body.cmcInvites, OUTCOMES);
    // without request invites
    const k3 = await newKey();
    const r3 = await coreRequest.post('/reg/access/' + k3).send({ ...ACCEPT, cmcInviteOutcomes: OUTCOMES });
    assert.strictEqual(r3.status, 200);
    const poll = await coreRequest.get('/reg/access/' + k3);
    assert.ok(!('cmcInvites' in poll.body), JSON.stringify(poll.body));
  });

  it('[RCI7] a hand-off accept keeps the outcomes beside the hand-off key', async () => {
    const key = await newKey({ cmcInvites: INVITES, credentialHandoff: 'shared-secret' });
    const handoff = { type: 'shared-secret', key: cuid() + '.' + 'k'.repeat(40) };
    const post = await coreRequest.post('/reg/access/' + key)
      .send({ status: 'ACCEPTED', username: 'alice', apiEndpoint: 'https://alice.pryv.me/', handoff, cmcInvites: OUTCOMES });
    assert.strictEqual(post.status, 200, JSON.stringify(post.body));
    assert.deepStrictEqual(post.body.handoff, handoff);
    assert.deepStrictEqual(post.body.cmcInvites, OUTCOMES);
    const poll = await coreRequest.get('/reg/access/' + key);
    assert.deepStrictEqual(poll.body.cmcInvites, OUTCOMES);
    assert.ok(!('token' in poll.body));
  });
});
