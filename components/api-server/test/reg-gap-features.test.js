/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Tests for gap features: service-register routes merged into service-core.
 * Sequential — some tests modify platform state.
 */

/* global initTests, initCore, coreRequest, assert, config, app, injectTestConfigSnapshot */

const { listeningAgent } = require('test-helpers');

describe('[RGGF] Register gap features', () => {
  let adminAccessKey;
  let savedIntegrityCheck;

  before(async function () {
    this.timeout(30000);
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    await initTests();
    await initCore();
    adminAccessKey = config.get('auth:adminAccessKey');
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

  // --- Feature 6: GET /service/infos (plural alias) ---

  describe('GET /:username/service/infos (alias)', () => {
    it('[GF01] must return same status and structure as /service/info', async () => {
      const resInfo = await coreRequest.get('/userzero/service/info');
      const resInfos = await coreRequest.get('/userzero/service/infos');
      assert.strictEqual(resInfos.status, resInfo.status);
      // Compare without serverTime (differs between requests)
      delete resInfo.body.meta?.serverTime;
      delete resInfos.body.meta?.serverTime;
      assert.deepStrictEqual(resInfos.body, resInfo.body);
    });
  });

  // --- Feature 5: GET /apps, GET /apps/:appid ---

  describe('GET /apps', () => {
    it('[GF10] must return apps list (may be empty)', async () => {
      const res = await coreRequest.get('/apps');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.apps), 'Expected apps array');
    });

    it('[GF11] must return 404 for unknown appid', async () => {
      const res = await coreRequest.get('/apps/nonexistent-app-xyz');
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, 'unknown-resource');
    });
  });

  // --- Feature 1: POST /access/invitationtoken/check ---

  describe('POST /access/invitationtoken/check', () => {
    it('[GF20] must return true when invitationTokens config is null (allow all)', async () => {
      // Default test config has invitationTokens as array or null
      const tokens = config.get('invitationTokens');
      if (tokens != null && !tokens.includes('enjoy')) {
        // Skip if tokens are configured but 'enjoy' is not in the list
        return;
      }
      const tokenToCheck = tokens == null ? 'anything' : 'enjoy';
      const res = await coreRequest.post('/access/invitationtoken/check')
        .send({ invitationtoken: tokenToCheck });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.text, 'true');
    });

    it('[GF21] must return false for invalid token when tokens are configured', async () => {
      const tokens = config.get('invitationTokens');
      if (tokens == null) {
        // Tokens not configured — skip (any token is valid)
        return;
      }
      const res = await coreRequest.post('/access/invitationtoken/check')
        .send({ invitationtoken: 'definitely-not-valid-token-xyz' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.text, 'false');
    });

    it('[IVCK1] past ten checks a minute an address is refused with 429; another address is not', async () => {
      const checkFrom = (address) => coreRequest.post('/access/invitationtoken/check')
        .set('X-Forwarded-For', address).send({ invitationtoken: 'ivck-' + address });
      try {
        for (let i = 0; i < 10; i++) {
          const res = await checkFrom('203.0.113.50');
          assert.strictEqual(res.status, 200, 'check ' + i + ': ' + res.text);
        }
        const refused = await checkFrom('203.0.113.50');
        assert.strictEqual(refused.status, 429, refused.text);
        assert.strictEqual(refused.body.error.id, 'too-many-attempts');
        assert.ok(Number(refused.headers['retry-after']) >= 1, 'a Retry-After header is set');
        assert.strictEqual((await checkFrom('203.0.113.51')).status, 200);
      } finally {
        await require('../src/routes/reg/invitationCheckBudget.ts').clear();
      }
    });
  });

  // --- The register host maps every request to /reg/*: the same answers there ---

  describe('[RGHO] on the register host (reg.<domain>)', () => {
    const regHost = 'reg.test-reg-host.pryv.li';
    let regRequest;
    // The test core runs dnsLess, where the register-host mapping is off. Put
    // the front of a DNS-topology app (its host mapping middleware included)
    // before the test core, so a reg.<domain> request reaches the core's routes
    // exactly as on a DNS deployment.
    before(async () => {
      const { expressAppInit } = require('../src/expressApp.ts');
      const restore = injectTestConfigSnapshot({ dnsLess: { isActive: false } });
      let front;
      try {
        front = await expressAppInit(app.logging);
      } finally {
        restore();
      }
      front.use((req, res, next) => app.expressApp(req, res, next));
      regRequest = await listeningAgent(front);
    });
    // A fall-through to the per-user router answers 404 'Unknown user "reg"'.
    function assertNotUserRoute (res) {
      assert.ok(!/Unknown user/.test(res.text), 'answered by the user route: ' + res.text);
    }

    it('[RHAP] GET /apps lists the same apps as at the root of a core', async () => {
      const atRoot = await coreRequest.get('/apps');
      assert.strictEqual(atRoot.status, 200, atRoot.text);
      const res = await regRequest.get('/apps').set('Host', regHost);
      assertNotUserRoute(res);
      assert.strictEqual(res.status, 200, res.text);
      assert.deepStrictEqual(res.body.apps, atRoot.body.apps);
    });

    it('[RHAO] GET /apps/{appid} answers from the apps list', async () => {
      const unknown = await regRequest.get('/apps/nonexistent-app-xyz').set('Host', regHost);
      assertNotUserRoute(unknown);
      assert.strictEqual(unknown.status, 404, unknown.text);
      assert.strictEqual(unknown.body.error.message, 'Unknown app: nonexistent-app-xyz');
      const apps = (await coreRequest.get('/apps')).body.apps;
      if (apps.length > 0) {
        const res = await regRequest.get('/apps/' + apps[0].id).set('Host', regHost);
        assert.strictEqual(res.status, 200, res.text);
        assert.strictEqual(res.body.app.id, apps[0].id);
      }
    });

    it('[RHIV] POST /access/invitationtoken/check answers true/false, as at the root of a core', async () => {
      const token = 'rhiv-token';
      try {
        const res = await regRequest.post('/access/invitationtoken/check').set('Host', regHost)
          .set('X-Forwarded-For', '203.0.113.60').send({ invitationtoken: token });
        assertNotUserRoute(res);
        assert.strictEqual(res.status, 200, res.text);
        assert.ok(['true', 'false'].includes(res.text), 'plain-text true or false: ' + res.text);
        const atRoot = await coreRequest.post('/access/invitationtoken/check')
          .set('X-Forwarded-For', '203.0.113.61').send({ invitationtoken: token });
        assert.strictEqual(atRoot.status, 200, atRoot.text);
        assert.strictEqual(res.text, atRoot.text);
      } finally {
        await require('../src/routes/reg/invitationCheckBudget.ts').clear();
      }
    });
  });

  // --- Feature 4: DELETE /system/users/:username with onlyReg/dryRun ---

  describe('DELETE /system/users/:username', () => {
    it('[GF30] must require onlyReg=true', async () => {
      const res = await coreRequest.delete('/system/users/someuser')
        .set('Authorization', adminAccessKey);
      // Without onlyReg=true → error
      assert.ok(res.status >= 400, 'Should fail without onlyReg');
    });

    it('[GF31] must support dryRun without deleting', async () => {
      // First register a user so they exist in PlatformDB
      const username = 'gfdryrun' + Date.now().toString(36);
      const regRes = await coreRequest.post('/users').send({
        appId: 'test-gf',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
        language: 'en'
      });
      assert.ok(regRes.status === 201 || regRes.status === 200,
        `Registration failed: ${regRes.status} ${JSON.stringify(regRes.body)}`);
      const res = await coreRequest.delete(`/system/users/${username}?onlyReg=true&dryRun=true`)
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.result.dryRun, true);
      assert.strictEqual(res.body.result.deleted, false);
    });

    it('[GF32] must return 404 for unknown user', async () => {
      const res = await coreRequest.delete('/system/users/unknown-user-xyz-999?onlyReg=true')
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 404);
    });

    it('[GF33] must reject without admin auth', async () => {
      const res = await coreRequest.delete('/system/users/userzero?onlyReg=true&dryRun=true');
      assert.strictEqual(res.status, 404); // system routes return 404 for unauth
    });

    it('[GF34] onlyReg removes the registration only: the account stays hosted and usable', async () => {
      const username = 'gfonlyreg' + Date.now().toString(36);
      const password = 'testpassw0rd';
      const regRes = await coreRequest.post('/users').send({
        appId: 'test-gf',
        username,
        password,
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
        language: 'en'
      });
      assert.ok(regRes.status === 201 || regRes.status === 200, JSON.stringify(regRes.body));
      const res = await coreRequest.delete(`/system/users/${username}?onlyReg=true`).set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const login = await coreRequest.post(`/${username}/auth/login`)
        .send({ username, password, appId: 'pryv-test-no-cors' });
      assert.strictEqual(login.status, 200, 'still hosted: ' + JSON.stringify(login.body));
      const usersRepository = await require('business/src/users/index.ts').getUsersRepository();
      await usersRepository.deleteOne(await usersRepository.getUserIdForUsername(username), username);
    });
  });

  // --- Feature 2: POST /system/users/validate ---

  describe('POST /system/users/validate', () => {
    it('[GF40] must validate and reserve unique fields for new user', async () => {
      const username = 'gfvalidate' + Date.now().toString(36);
      const res = await coreRequest.post('/system/users/validate')
        .set('Authorization', adminAccessKey)
        .send({
          username,
          invitationToken: config.get('invitationTokens')?.[0] || 'any',
          uniqueFields: { email: username + '@test.example.com' }
        });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.reservation, true);
    });

    it('[GF41] must reject duplicate username', async () => {
      // First register a user so username is in PlatformDB
      const username = 'gfdup' + Date.now().toString(36);
      await coreRequest.post('/users').send({
        appId: 'test-gf',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
        language: 'en'
      });
      // Now try to validate the same username
      const res = await coreRequest.post('/system/users/validate')
        .set('Authorization', adminAccessKey)
        .send({
          username,
          invitationToken: config.get('invitationTokens')?.[0] || 'any',
          uniqueFields: {}
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.reservation, false);
      assert.ok(res.body.error.data.username, 'Should flag username conflict');
    });

    it('[GF42] must reject invalid invitation token', async () => {
      const tokens = config.get('invitationTokens');
      if (tokens == null) return; // No tokens configured — skip
      const res = await coreRequest.post('/system/users/validate')
        .set('Authorization', adminAccessKey)
        .send({
          username: 'gfvalidate' + Date.now().toString(36),
          invitationToken: 'invalid-token-xyz',
          uniqueFields: {}
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.reservation, false);
    });

    it('[GF43] must reject without admin auth', async () => {
      const res = await coreRequest.post('/system/users/validate')
        .send({ username: 'test', uniqueFields: {} });
      assert.strictEqual(res.status, 404);
    });
  });

  // --- Feature 3: PUT /system/users ---

  describe('PUT /system/users', () => {
    let updateTestUser;
    before(async () => {
      updateTestUser = 'gfupdate' + Date.now().toString(36);
      await coreRequest.post('/users').send({
        appId: 'test-gf',
        username: updateTestUser,
        password: 'testpassw0rd',
        email: updateTestUser + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
        language: 'en'
      });
    });

    it('[GF50] must update user fields', async () => {
      const res = await coreRequest.put('/system/users')
        .set('Authorization', adminAccessKey)
        .send({
          username: updateTestUser,
          user: { language: 'fr' }
        });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.user, true);
    });

    it('[SYUU2] a unique value another account holds is refused with 409 and stays with its holder', async () => {
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const holder = 'gfholder' + Date.now().toString(36);
      const reg = await coreRequest.post('/users').send({
        appId: 'test-gf',
        username: holder,
        password: 'testpassw0rd',
        email: holder + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
        language: 'en'
      });
      assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
      const taken = await coreRequest.put('/system/users').set('Authorization', adminAccessKey)
        .send({ username: updateTestUser, user: { email: holder + '@test.example.com', language: 'de' } });
      assert.strictEqual(taken.status, 409, JSON.stringify(taken.body));
      assert.strictEqual(taken.body.error.id, 'item-already-exists');
      assert.strictEqual(await platform.getUsersUniqueField('email', holder + '@test.example.com'), platform.hashFor('username', holder));
      const free = updateTestUser + '-other@test.example.com';
      const ok = await coreRequest.put('/system/users').set('Authorization', adminAccessKey)
        .send({ username: updateTestUser, user: { email: free } });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(await platform.getUsersUniqueField('email', free), platform.hashFor('username', updateTestUser));
    });

    it('[GF51] must reject without username', async () => {
      const res = await coreRequest.put('/system/users')
        .set('Authorization', adminAccessKey)
        .send({ user: { language: 'en' } });
      assert.ok(res.status >= 400);
    });

    it('[GF52] must reject without admin auth', async () => {
      const res = await coreRequest.put('/system/users')
        .send({ username: 'userzero', user: { language: 'en' } });
      assert.strictEqual(res.status, 404);
    });
  });
});
