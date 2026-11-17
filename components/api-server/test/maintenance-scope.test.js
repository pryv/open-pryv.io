/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [MNSC] work that legitimately runs longer than a request may (account
 * erasure, the background storage-size pass) runs in the maintenance scope,
 * where the database time limits of request handling do not apply. Checked on
 * the real code paths: the scope must reach every erasure step, whatever
 * awaits lie between the entry point and the statements.
 */

/* global initTests, initCore, getNewFixture, coreRequest, assert, cuid */

const sinon = require('sinon');
const { getConfig } = require('@pryv/boiler');
const { getStorageLayer, Size } = require('storage');
const { isInMaintenance } = require('storages');
const { Deletion } = require('business/src/auth/deletion.ts');
const { startStorageUsedJob } = require('api-server/src/methods/helpers/storageUsedJob.ts');

const ERASURE_STEPS = ['deleteUserFiles', 'deleteHFData', 'deleteAttachments', 'deleteAuditDataStorage', 'deleteUser', 'deleteAuditData', 'dropHFDataAgain'];

describe('[MNSC] maintenance scope on long legitimate work', function () {
  this.timeout(60000);
  let config, storageLayer, fixture;

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();
    storageLayer = await getStorageLayer();
    fixture = getNewFixture();
  });

  after(async function () {
    sinon.restore();
    await fixture.clean();
  });

  afterEach(() => sinon.restore());

  it('[MNSC1] every step of an account erasure runs in the maintenance scope', async () => {
    const username = ('mnsc' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const user = await fixture.user(username);
    const stream = await user.stream({ id: 'mnsc-' + cuid().slice(-10), name: 'MNSC' });
    await stream.event({ type: 'note/txt', content: 'to erase' });
    const seen = {};
    for (const name of ERASURE_STEPS) {
      const original = Deletion.prototype[name];
      sinon.stub(Deletion.prototype, name).callsFake(function (...args) {
        seen[name] = isInMaintenance();
        return original.apply(this, args);
      });
    }
    assert.strictEqual(isInMaintenance(), false);
    await new Deletion(null, storageLayer, config).eraseAccount({ id: user.attrs.id, username }, { teardown: false });
    assert.deepStrictEqual(Object.keys(seen).sort(), [...ERASURE_STEPS].sort(), 'every step ran');
    for (const name of ERASURE_STEPS) assert.strictEqual(seen[name], true, name + ' ran in the maintenance scope');
    assert.strictEqual(isInMaintenance(), false, 'the scope does not leak to the caller');
  });

  it('[MNSC3] the scope covers an erasure step only: what follows its `next` is limited again', async () => {
    let inStep = null;
    sinon.stub(Deletion.prototype, 'openErasureRecord').callsFake(function (context, params, result, next) {
      inStep = isInMaintenance();
      next();
    });
    const [firstStep] = new Deletion(null, storageLayer, config).erasureSteps({ teardown: false });
    const afterNext = await new Promise((resolve) => {
      firstStep({ user: { id: 'mnsc3', username: 'mnsc3' } }, {}, {}, () => resolve(isInMaintenance()));
    });
    assert.strictEqual(inStep, true, 'the step runs in the scope');
    assert.strictEqual(afterNext, false, 'the rest of the chain does not');
  });

  it('[MNSC2] a storage-size pass runs in the maintenance scope', async () => {
    const user = await fixture.user(('mnsd' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20));
    assert.ok(user);
    const seen = [];
    let resolvePass;
    const passed = new Promise((resolve) => { resolvePass = resolve; });
    sinon.stub(Size.prototype, 'computeForUser').callsFake(async function () {
      seen.push(isInMaintenance());
      resolvePass();
    });
    const job = startStorageUsedJob({ get: (key) => key === 'account:storageUsed:intervalHours' ? 24 : config.get(key) }, { firstPassDelayMs: 0 });
    try {
      await passed;
    } finally {
      job.stop();
    }
    assert.ok(seen.length > 0);
    assert.ok(seen.every((v) => v === true), 'computed in the maintenance scope');
  });
});

describe('[STMC] a statement stopped by the database time limit, through the API', function () {
  this.timeout(60000);
  let fixture, username, token, mall;

  before(async function () {
    await initTests();
    await initCore();
    fixture = getNewFixture();
    username = ('stmc' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const user = await fixture.user(username);
    token = cuid();
    await user.access({ type: 'personal', token });
    await user.session(token);
    mall = await require('mall').getMall();
  });

  after(async function () {
    sinon.restore();
    await fixture.clean();
  });

  it('[STMC1] answers 503 api-unavailable without Retry-After, and the next call is served', async () => {
    const original = mall.streams.get.bind(mall.streams);
    sinon.stub(mall.streams, 'get').callsFake(async (userId, query) => {
      if (query?.childrenDepth === -1) {
        const err = new Error('canceling statement due to statement timeout');
        err.code = '57014';
        throw err;
      }
      return original(userId, query);
    });
    const res = await coreRequest.get('/' + username + '/streams').set('Authorization', token);
    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'api-unavailable');
    assert.match(res.body.error.message, /ran longer than this server allows/);
    assert.strictEqual(res.headers['retry-after'], undefined);
    sinon.restore();
    const ok = await coreRequest.get('/' + username + '/streams').set('Authorization', token);
    assert.strictEqual(ok.status, 200);
  });

  // The real path: the statement fails in the PostgreSQL store, the store
  // layer and then the method each wrap the error on the way up.
  it('[STMC2] a statement cancelled in the store answers 503 on events.getOne and events.update', async function () {
    const { databasePG } = require('storages');
    if (databasePG == null) return this.skip(); // PostgreSQL only
    const streamId = 'stmc-' + cuid().slice(-10);
    const created = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id: streamId, name: 'STMC ' + streamId });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const ev = await coreRequest.post('/' + username + '/events').set('Authorization', token).send({ streamIds: [streamId], type: 'note/txt', content: 'x' });
    assert.strictEqual(ev.status, 201, JSON.stringify(ev.body));
    const eventId = ev.body.event.id;
    const original = databasePG.pool.query.bind(databasePG.pool);
    sinon.stub(databasePG.pool, 'query').callsFake(async (text, params) => {
      if (Array.isArray(params) && params.includes(eventId)) {
        const err = new Error('canceling statement due to statement timeout');
        err.code = '57014';
        throw err;
      }
      return original(text, params);
    });
    try {
      const get = await coreRequest.get('/' + username + '/events/' + eventId).set('Authorization', token);
      assert.strictEqual(get.status, 503, JSON.stringify(get.body));
      assert.strictEqual(get.body.error.id, 'api-unavailable');
      const update = await coreRequest.put('/' + username + '/events/' + eventId).set('Authorization', token).send({ content: 'y' });
      assert.strictEqual(update.status, 503, JSON.stringify(update.body));
      assert.strictEqual(update.body.error.id, 'api-unavailable');
    } finally {
      sinon.restore();
    }
  });
});
