/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Tests for legacy service-register routes and invitation management.
 * Sequential — modifies platform state.
 */

/* global initTests, initCore, coreRequest, assert, config */

const { captureWarnings } = require('test-helpers/src/captureWarnings.ts');

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
    const { getUsersRepository } = require('business/src/users/index.ts');
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

    it('[LG42] generated token is stored hashed: the raw token is not exposed in the listing, the entry appears under its hash', async () => {
      const crypto = require('node:crypto');
      const genRes = await coreRequest.get('/reg/admin/invitations/post?count=1&message=lg42-marker')
        .set('Authorization', adminAccessKey);
      const token = genRes.body.data[0].id; // raw token, shown once to the admin

      const listRes = await coreRequest.get('/reg/admin/invitations')
        .set('Authorization', adminAccessKey);
      // PlatformDB is replicated to every core, so the listing must never carry
      // a usable token. The raw token is not an id here.
      const rawLeak = listRes.body.invitations.find(t => t.id === token);
      assert.ok(!rawLeak, `raw token ${token} must not appear in the invitations listing`);
      // It is stored under its SHA-256, still discoverable by that key + metadata.
      const hashed = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
      const found = listRes.body.invitations.find(t => t.id === hashed);
      assert.ok(found, 'token must be listed under its hash');
      assert.strictEqual(found.description, 'lg42-marker');
      assert.strictEqual(found.keyHashed, undefined, 'internal keyHashed marker must not be exposed');
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

    it('[LG45] a wrong key answers 404 and logs a warning with the client IP but not the key', async () => {
      const nearMiss = adminAccessKey.slice(0, -1) + 'x';
      const capture = captureWarnings();
      let res;
      try {
        res = await coreRequest.get('/reg/admin/invitations').set('Authorization', nearMiss);
      } finally {
        capture.restore();
      }
      assert.strictEqual(res.status, 404);
      const warning = capture.warnings.find((w) => /Unauthorized attempt/.test(String(w.args[0])));
      assert.ok(warning != null, 'a warning is logged');
      assert.ok(typeof warning.args[1].ip === 'string' && warning.args[1].ip.length > 0, 'with the client IP');
      assert.ok(!JSON.stringify(warning.args).includes(nearMiss), 'never the key sent');
    });
  });

  // --- Invitation token consumption ---

  describe('[LGIC] invitation token consumption', () => {
    async function newToken () {
      const res = await coreRequest.get('/reg/admin/invitations/post?count=1')
        .set('Authorization', adminAccessKey);
      return res.body.data[0].id;
    }

    function registration (invitationToken, overrides = {}) {
      const username = 'lgic' + Math.random().toString(36).slice(2, 10);
      return Object.assign({
        appId: 'test-legacy',
        username,
        password: 'testpassw0rd',
        email: username + '@legacy-test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
        language: 'en',
        invitationToken
      }, overrides);
    }

    async function isValid (token) {
      const res = await coreRequest.post('/access/invitationtoken/check').send({ invitationtoken: token });
      return res.text === 'true';
    }

    it('[LG50] two concurrent registrations with one token: exactly one account is created', async () => {
      const token = await newToken();
      const bodies = [registration(token), registration(token)];
      const results = await Promise.all(bodies.map((b) => coreRequest.post('/users').send(b)));
      const statuses = results.map((r) => r.status).sort();
      assert.deepStrictEqual(statuses, [201, 400], JSON.stringify(results.map((r) => r.body)));
      const refused = results.find((r) => r.status === 400);
      assert.strictEqual(refused.body.error.id, 'invalid-operation');
      const { getUsersRepository } = require('business/src/users/index.ts');
      const usersRepository = await getUsersRepository();
      const created = await Promise.all(bodies.map((b) => usersRepository.usernameExists(b.username)));
      assert.strictEqual(created.filter(Boolean).length, 1, 'one account only');
      assert.strictEqual(await isValid(token), false, 'the token is consumed');
    });

    it('[LG51] a registration refused after the token check gives the token back', async () => {
      const token = await newToken();
      // the email is already taken: refused once the token is claimed
      let res = await coreRequest.post('/users').send(registration(token, { email: testEmail }));
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(await isValid(token), true, 'the token is still usable');
      res = await coreRequest.post('/users').send(registration(token));
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(await isValid(token), false);
    });
  });

  describe('POST /access/invitationtoken/check', () => {
    it('[LG52] a platform failure answers 500 instead of crashing the worker', async () => {
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      platform.isInvitationTokenValid = async () => { throw new Error('platform unavailable'); };
      let res;
      try {
        res = await coreRequest.post('/access/invitationtoken/check').send({ invitationtoken: 'x' });
      } finally {
        delete platform.isInvitationTokenValid;
      }
      assert.strictEqual(res.status, 500);
      assert.strictEqual(typeof platform.isInvitationTokenValid, 'function', 'prototype method restored');
    });
  });
});
