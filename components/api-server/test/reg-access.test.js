/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, assert */

const accessState = require('../src/routes/reg/accessState');

describe('[RGAC] Register access authorization', () => {
  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
  });

  afterEach(() => {
    accessState.clear();
  });

  describe('POST /reg/access', () => {
    it('[RA01] must create an access request and return polling key', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, 'NEED_SIGNIN');
      assert.ok(res.body.key);
      assert.strictEqual(res.body.key.length, 16);
      assert.strictEqual(res.body.requestingAppId, 'test-app');
      assert.deepStrictEqual(res.body.requestedPermissions, [{ streamId: 'diary', level: 'read' }]);
      assert.ok(res.body.poll);
      assert.strictEqual(res.body.poll_rate_ms, 1000);
    });

    it('[RA02] must return 400 for missing requestingAppId', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({ requestedPermissions: [{ streamId: 'diary', level: 'read' }] });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
    });

    it('[RA03] must return 400 for missing requestedPermissions', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({ requestingAppId: 'test-app' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
    });

    it('[RA04] must echo clientData and oauthState', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }],
          clientData: { foo: 'bar' },
          oauthState: 'xyz123'
        });
      assert.strictEqual(res.status, 201);
      assert.deepStrictEqual(res.body.clientData, { foo: 'bar' });
      assert.strictEqual(res.body.oauthState, 'xyz123');
    });
  });

  describe('GET /reg/access/:key', () => {
    it('[RA10] must return current state for valid key', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const res = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, 'NEED_SIGNIN');
      assert.strictEqual(res.body.requestingAppId, 'test-app');
    });

    it('[RA11] must return 400 for unknown key', async () => {
      const res = await coreRequest.get('/reg/access/nonexistentkey00');
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'unknown-access-key');
    });
  });

  describe('POST /reg/access/:key (accept)', () => {
    it('[RA20] must accept and return token + apiEndpoint', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const acceptRes = await coreRequest.post('/reg/access/' + key)
        .send({
          status: 'ACCEPTED',
          username: 'testuser',
          token: 'abc123token',
          apiEndpoint: 'https://testuser.pryv.me/'
        });
      assert.strictEqual(acceptRes.status, 200);
      assert.strictEqual(acceptRes.body.status, 'ACCEPTED');
      assert.strictEqual(acceptRes.body.username, 'testuser');
      assert.strictEqual(acceptRes.body.token, 'abc123token');
      assert.strictEqual(acceptRes.body.apiEndpoint, 'https://testuser.pryv.me/');
    });

    it('[RA21] subsequent poll must return ACCEPTED state', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      await coreRequest.post('/reg/access/' + key)
        .send({
          status: 'ACCEPTED',
          username: 'testuser',
          token: 'abc123token',
          apiEndpoint: 'https://testuser.pryv.me/'
        });

      const pollRes = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(pollRes.status, 200);
      assert.strictEqual(pollRes.body.status, 'ACCEPTED');
      assert.strictEqual(pollRes.body.token, 'abc123token');
    });

    it('[RA22] must return 400 for ACCEPTED without token', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const res = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'ACCEPTED', username: 'testuser' });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('POST /reg/access/:key (refuse)', () => {
    it('[RA30] must refuse with reason', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const refuseRes = await coreRequest.post('/reg/access/' + key)
        .send({
          status: 'REFUSED',
          reasonID: 'USER_DENIED',
          message: 'User denied access'
        });
      assert.strictEqual(refuseRes.status, 403);
      assert.strictEqual(refuseRes.body.status, 'REFUSED');
      assert.strictEqual(refuseRes.body.reasonID, 'USER_DENIED');
    });

    it('[RA31] subsequent poll must return REFUSED state', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      await coreRequest.post('/reg/access/' + key)
        .send({ status: 'REFUSED', reasonID: 'USER_DENIED', message: 'No' });

      const pollRes = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(pollRes.status, 403);
      assert.strictEqual(pollRes.body.status, 'REFUSED');
    });
  });

  describe('POST /reg/access/:key (errors)', () => {
    it('[RA40] must return 400 for invalid status', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const res = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'INVALID' });
      assert.strictEqual(res.status, 400);
    });

    it('[RA41] must return 400 for unknown key', async () => {
      const res = await coreRequest.post('/reg/access/nonexistentkey00')
        .send({ status: 'REFUSED', reasonID: 'test', message: 'test' });
      assert.strictEqual(res.status, 400);
    });
  });
});
