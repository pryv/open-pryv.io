/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Tests for legacy service-register routes and invitation management.
 * Sequential — modifies platform state.
 */

/* global initTests, initCore, coreRequest, assert, config */

describe('[RGLG] Legacy register routes + invitations', () => {
  let adminAccessKey;
  let testUser;
  let testEmail;
  let savedIntegrityCheck;

  before(async function () {
    this.timeout(30000);
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    await initTests();
    await initCore();
    adminAccessKey = config.get('auth:adminAccessKey');

    // Register a test user for lookup tests
    testUser = 'lgtest' + Date.now().toString(36);
    testEmail = testUser + '@legacy-test.example.com';
    const regRes = await coreRequest.post('/users').send({
      appId: 'test-legacy',
      username: testUser,
      password: 'testpassw0rd',
      email: testEmail,
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en'
    });
    assert.ok(regRes.status === 201 || regRes.status === 200,
      `Registration failed: ${regRes.status} ${JSON.stringify(regRes.body)}`);
  });

  after(async function () {
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  // --- Email → username lookups ---

  describe('GET /reg/:email/username', () => {
    it('[LG01] must return username for known email', async () => {
      const res = await coreRequest.get(`/reg/${encodeURIComponent(testEmail)}/username`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.username, testUser);
    });

    it('[LG02] must return 404 for unknown email', async () => {
      const res = await coreRequest.get('/reg/unknown-xyz@nowhere.com/username');
      assert.strictEqual(res.status, 404);
    });
  });

  describe('GET /reg/:email/uid (deprecated)', () => {
    it('[LG03] must return uid for known email', async () => {
      const res = await coreRequest.get(`/reg/${encodeURIComponent(testEmail)}/uid`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.uid, testUser);
    });
  });

  // --- Server/core discovery ---

  describe('GET /reg/:uid/server', () => {
    it('[LG10] must redirect for known user', async () => {
      const res = await coreRequest.get(`/reg/${testUser}/server`).redirects(0);
      assert.strictEqual(res.status, 302);
    });

    it('[LG11] must return 404 for unknown user', async () => {
      const res = await coreRequest.get('/reg/unknown-user-xyz-999/server');
      assert.strictEqual(res.status, 404);
    });
  });

  describe('POST /reg/:uid/server', () => {
    it('[LG12] must return server and alias for known user', async () => {
      const res = await coreRequest.post(`/reg/${testUser}/server`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.server, 'Expected server field');
      assert.ok(res.body.alias, 'Expected alias field');
    });

    it('[LG13] must return 404 for unknown user', async () => {
      const res = await coreRequest.post('/reg/unknown-user-xyz-999/server');
      assert.strictEqual(res.status, 404);
    });
  });

  // --- Admin: user details ---

  describe('GET /reg/admin/users/:username', () => {
    it('[LG20] must return user info with admin auth', async () => {
      const res = await coreRequest.get(`/reg/admin/users/${testUser}`)
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.username, testUser);
    });

    it('[LG21] must return 404 for unknown user', async () => {
      const res = await coreRequest.get('/reg/admin/users/unknown-user-xyz-999')
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 404);
    });

    it('[LG22] must reject without admin auth', async () => {
      const res = await coreRequest.get(`/reg/admin/users/${testUser}`);
      assert.strictEqual(res.status, 404);
    });
  });

  // --- Admin: servers ---

  describe('GET /reg/admin/servers', () => {
    it('[LG30] must return servers object with admin auth', async () => {
      const res = await coreRequest.get('/reg/admin/servers')
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.servers, 'Expected servers object');
      assert.ok(typeof res.body.servers === 'object');
    });
  });

  // --- Invitations ---

  describe('GET /reg/admin/invitations', () => {
    it('[LG40] must return invitations list with admin auth', async () => {
      const res = await coreRequest.get('/reg/admin/invitations')
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.invitations), 'Expected invitations array');
    });
  });

  describe('GET /reg/admin/invitations/post', () => {
    it('[LG41] must generate invitation tokens', async () => {
      const res = await coreRequest.get('/reg/admin/invitations/post?count=3&message=test')
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.data), 'Expected data array');
      assert.strictEqual(res.body.data.length, 3);
      assert.ok(res.body.data[0].id, 'Token must have id');
      assert.ok(res.body.data[0].createdAt, 'Token must have createdAt');
    });

    it('[LG42] generated tokens must appear in invitations list', async () => {
      const genRes = await coreRequest.get('/reg/admin/invitations/post?count=1')
        .set('Authorization', adminAccessKey);
      const token = genRes.body.data[0].id;

      const listRes = await coreRequest.get('/reg/admin/invitations')
        .set('Authorization', adminAccessKey);
      const found = listRes.body.invitations.find(t => t.id === token);
      assert.ok(found, `Generated token ${token} should appear in list`);
    });

    it('[LG43] generated tokens must be valid for registration check', async () => {
      const genRes = await coreRequest.get('/reg/admin/invitations/post?count=1')
        .set('Authorization', adminAccessKey);
      const token = genRes.body.data[0].id;

      const checkRes = await coreRequest.post('/access/invitationtoken/check')
        .send({ invitationtoken: token });
      assert.strictEqual(checkRes.status, 200);
      assert.strictEqual(checkRes.text, 'true');
    });

    it('[LG44] must reject without admin auth', async () => {
      const res = await coreRequest.get('/reg/admin/invitations/post?count=1');
      assert.strictEqual(res.status, 404);
    });
  });
});
