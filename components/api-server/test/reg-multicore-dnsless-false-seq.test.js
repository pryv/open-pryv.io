/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * regression suite — exercises the multi-core / dnsLess=false
 * behaviours surfaced during the pryv.me migration session on 2026-04-20.
 *
 * Covers:
 *   [MC-FWD] cross-core registration transparent forward
 *   [MC-ACC] /reg/access POST + GET response shape (authUrl, poll, lang, serviceInfo)
 *   [MC-SVC] /service/info required fields + version
 *
 * Sequential because it mutates shared config + global.fetch.
 */

const assert = require('node:assert');
const supertest = require('supertest');
const cuid = require('cuid');
const charlatan = require('charlatan');

const { getConfig } = require('@pryv/boiler');
const { getApplication } = require('api-server/src/application');
const { platform } = require('platform');
const accessState = require('../src/routes/reg/accessState');

const DOMAIN = 'test-plan37.pryv.li';
const CORE_A = 'core-a';
const CORE_B = 'core-b';

function buildCoreUrl (coreId) {
  return 'https://' + coreId + '.' + DOMAIN;
}

describe('[RGMD] register: multi-core (dnsLess=false path)', function () {
  this.timeout(60000);

  let config;
  let savedIntegrityCheck;
  let savedPlatformData;
  let savedService;
  let savedCoreUrl;
  let savedCoreId;
  let savedDnsDomain;
  let savedIsSingleCore;

  function getPlatformDB () {
    return require('storages').platformDB;
  }

  before(async function () {
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    config = await getConfig();
    const app = getApplication(true);
    await app.initiate();
    await platform.init();
    // Snapshot config keys we mutate so later tests (e.g. [SINF], [SVIF]) see
    // the original `service.*` / `core.*` / `dns.domain` / `core:isSingleCore`
    // values — without this the multi-core URL rewrites and single-core
    // resets leak across describes.
    savedService = config.get('service');
    savedCoreUrl = config.get('core:url');
    savedCoreId = config.get('core:id');
    savedDnsDomain = config.get('dns:domain');
    savedIsSingleCore = config.get('core:isSingleCore');
    const allData = await getPlatformDB().exportAll();
    savedPlatformData = allData.filter(e => e.username != null);
    await getPlatformDB().clearAll();
    if (savedPlatformData.length > 0) {
      await getPlatformDB().importAll(savedPlatformData);
    }
  });

  after(async function () {
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    await getPlatformDB().clearAll();
    if (savedPlatformData && savedPlatformData.length > 0) {
      await getPlatformDB().importAll(savedPlatformData);
    }
    config.injectTestConfig({});
    // Restore mutated keys to their pre-describe values.
    config.set('service', savedService);
    config.set('core:url', savedCoreUrl || null);
    config.set('core:id', savedCoreId || null);
    config.set('dns:domain', savedDnsDomain || null);
    config.set('core:isSingleCore', savedIsSingleCore != null ? savedIsSingleCore : true);
    await platform.registerSelf();
    accessState.clear();
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  async function setupMultiCore (selfId) {
    config.injectTestConfig({
      dnsLess: { isActive: false },
      dns: { domain: DOMAIN },
      core: {
        id: selfId,
        ip: '10.0.0.1',
        hosting: 'us-east-1',
        available: true
      }
    });
    config.set('core:isSingleCore', false);
    config.set('core:url', buildCoreUrl(selfId));
    config.set('core:id', selfId);
    config.set('dns:domain', DOMAIN);
    await platform.registerSelf();
    await getPlatformDB().setCoreInfo('single', {
      id: 'single', available: false
    });
  }

  async function seedCore (coreId, info) {
    await getPlatformDB().setCoreInfo(coreId, Object.assign({
      id: coreId,
      ip: null,
      ipv6: null,
      cname: null,
      hosting: null,
      available: true
    }, info));
  }

  // ----------------------------------------------------------------
  // [MC-FWD] cross-core registration transparent forward
  // ----------------------------------------------------------------
  describe('[MC-FWD] cross-core registration forward', function () {
    let request;
    let realFetch;
    let forwardCalls;
    let forwardHandler; // ({url, options}) -> {ok,status,json} | throws
    let fwdSnapshot;

    const TARGET_FORWARD_URL = buildCoreUrl(CORE_B) + '/users';

    function installFetchInterceptor () {
      realFetch = global.fetch;
      global.fetch = async function (url, options) {
        if (url === TARGET_FORWARD_URL) {
          forwardCalls.push({ url, options });
          if (!forwardHandler) {
            throw new Error('no forwardHandler set');
          }
          return forwardHandler({ url, options });
        }
        return realFetch(url, options);
      };
    }

    function restoreFetch () {
      if (realFetch) global.fetch = realFetch;
      realFetch = null;
    }

    before(async function () {
      fwdSnapshot = (await getPlatformDB().exportAll()).filter(e => e.username != null);
      await setupMultiCore(CORE_A);
      await seedCore(CORE_B, { hosting: 'eu-central-1' });

      const app = getApplication(true);
      await app.initiate();
      await require('../src/methods/auth/register')(app.api);
      request = supertest(app.expressApp);
    });

    beforeEach(function () {
      forwardCalls = [];
      forwardHandler = null;
      installFetchInterceptor();
    });

    afterEach(async function () {
      restoreFetch();
      await getPlatformDB().clearAll();
      if (fwdSnapshot.length > 0) {
        await getPlatformDB().importAll(fwdSnapshot);
      }
      await platform.registerSelf();
      await seedCore(CORE_B, { hosting: 'eu-central-1' });
    });

    it('[MC11] forwards POST to target core when hosting maps elsewhere', async function () {
      const username = 'fwd01' + cuid.slug().toLowerCase();
      const fakeTargetResponse = {
        meta: { apiVersion: '2.0.0-pre.2', serverTime: 1.0 },
        username,
        apiEndpoint: 'https://tok@' + username + '.' + DOMAIN + '/'
      };
      forwardHandler = async () => ({
        ok: true,
        status: 201,
        json: async () => fakeTargetResponse
      });

      const res = await request.post('/users').send({
        appId: 'test-app',
        username,
        email: charlatan.Internet.email(),
        password: 'testpassword',
        hosting: 'eu-central-1',
        insurancenumber: charlatan.Number.number(3)
      });

      assert.strictEqual(res.status, 201, 'forward should yield 201: ' + JSON.stringify(res.body));
      // Forward was called exactly once, to the target core's /users endpoint
      assert.strictEqual(forwardCalls.length, 1, 'forward must happen exactly once');
      const { url: forwardedUrl, options: forwardedOptions } = forwardCalls[0];
      assert.strictEqual(forwardedUrl, buildCoreUrl(CORE_B) + '/users',
        'forward target must be target core /users');
      assert.strictEqual(forwardedOptions.method, 'POST');
      const forwardedBody = JSON.parse(forwardedOptions.body);
      assert.strictEqual(forwardedBody.username, username);
      assert.strictEqual(forwardedBody.hosting, 'eu-central-1');
      // Target's response passes through to the client (minus target's meta)
      assert.strictEqual(res.body.username, username);
      assert.strictEqual(res.body.apiEndpoint, fakeTargetResponse.apiEndpoint);
      // The legacy redirect shape (`core.url`) must NOT appear — client is
      // transparently receiving target's response, not a "re-POST" directive.
      assert.ok(!res.body.core, 'response must not contain legacy `core.url` redirect');
    });

    it('[MC12] does NOT forward when hosting maps to self', async function () {
      const username = 'fwd02' + cuid.slug().toLowerCase();
      const res = await request.post('/users').send({
        appId: 'test-app',
        username,
        email: charlatan.Internet.email(),
        password: 'testpassword',
        hosting: 'us-east-1',
        insurancenumber: charlatan.Number.number(3)
      });
      assert.strictEqual(forwardCalls.length, 0,
        'forward must not happen when target is self: ' + JSON.stringify(res.body));
      assert.strictEqual(res.status, 201,
        'local registration should succeed: ' + JSON.stringify(res.body));
      assert.ok(res.body.apiEndpoint, 'should return apiEndpoint for local registration');
    });

    it('[MC13] does NOT leak user-core row when forward fails', async function () {
      const username = 'fwd03' + cuid.slug().toLowerCase();
      forwardHandler = async () => {
        throw new Error('target unreachable');
      };

      const res = await request.post('/users').send({
        appId: 'test-app',
        username,
        email: charlatan.Internet.email(),
        password: 'testpassword',
        hosting: 'eu-central-1',
        insurancenumber: charlatan.Number.number(3)
      });

      // Forward failed → response is an error
      assert.notStrictEqual(res.status, 201, 'forward failure must not report 201');
      // user-core row MUST NOT be written — the previous design wrote it
      // during validateRegistration before forwarding, which left
      // orphaned mappings when the client didn't follow the redirect.
      const coreId = await platform.getUserCore(username);
      assert.strictEqual(coreId, null,
        'user-core/' + username + ' must not exist after failed forward');
    });
  });

  // ----------------------------------------------------------------
  // [MC-ACC] /reg/access POST + GET response shape
  // ----------------------------------------------------------------
  describe('[MC-ACC] /reg/access response shape', function () {
    let request;

    before(async function () {
      await setupMultiCore(CORE_A);
      const app = getApplication(true);
      await app.initiate();
      request = supertest(app.expressApp);
    });

    it('[MC14] POST /reg/access returns authUrl, poll, lang, serviceInfo, url (deprecated)', async function () {
      const res = await request.post('/reg/access').send({
        requestingAppId: 'test-app',
        requestedPermissions: [{ streamId: '*', level: 'read' }]
      });
      assert.strictEqual(res.status, 201);
      const body = res.body;
      assert.strictEqual(body.status, 'NEED_SIGNIN');
      assert.ok(body.key, 'must return key');
      assert.ok(body.poll, 'must return poll URL');
      assert.ok(body.poll.startsWith(buildCoreUrl(CORE_A)),
        'poll URL must be core-affine (pointing at this core): ' + body.poll);
      assert.strictEqual(typeof body.poll_rate_ms, 'number', 'must return poll_rate_ms');
      assert.strictEqual(body.lang, 'en', 'must return lang (default en)');
      // authUrl is populated only when access.defaultAuthUrl is configured.
      // With no config, authUrl is null — acceptable; real deployments always set it.
      if (body.authUrl) {
        assert.strictEqual(body.url, body.authUrl, 'url (deprecated) must equal authUrl');
        assert.ok(body.authUrl.includes('key=' + body.key),
          'authUrl must include the key query param');
        assert.ok(body.authUrl.includes('poll='),
          'authUrl must include the poll query param');
      }
      assert.ok(body.serviceInfo, 'must return serviceInfo');
      assert.ok(body.serviceInfo.name, 'serviceInfo.name must be set');
    });

    it('[MC15] GET /reg/access/:key NEED_SIGNIN response includes poll, authUrl, serviceInfo', async function () {
      const postRes = await request.post('/reg/access').send({
        requestingAppId: 'test-app',
        requestedPermissions: [{ streamId: '*', level: 'read' }]
      });
      const key = postRes.body.key;

      const getRes = await request.get('/reg/access/' + key);
      assert.strictEqual(getRes.status, 201);
      const body = getRes.body;
      assert.strictEqual(body.status, 'NEED_SIGNIN');
      assert.strictEqual(body.key, key);
      assert.ok(body.poll, 'GET response must include poll URL');
      assert.strictEqual(body.poll, postRes.body.poll,
        'GET poll URL must equal the one returned on POST');
      assert.ok(body.serviceInfo, 'GET must include serviceInfo');
      assert.ok(body.serviceInfo.name, 'serviceInfo.name must be set');
      assert.strictEqual(typeof body.poll_rate_ms, 'number');
      assert.strictEqual(body.lang, 'en');
    });
  });

  // ----------------------------------------------------------------
  // [MC-RST] v1→v2 restore: user-core rows from register/servers.jsonl.gz
  // ----------------------------------------------------------------
  describe('[MC-RST] RestoreOrchestrator user-core from register mappings', function () {
    let rstSnapshot;

    before(async function () {
      rstSnapshot = (await getPlatformDB().exportAll()).filter(e => e.username != null);
      // Clear any core-info rows leaked from previous describes (e.g. core-b
      // from [MC-FWD]). This test requires exactly one *available* core
      // so `defaultCoreId = availableCores[0].id` resolves deterministically.
      await getPlatformDB().clearAll();
      if (rstSnapshot.length > 0) {
        await getPlatformDB().importAll(rstSnapshot);
      }
      await setupMultiCore(CORE_A);
      // Only one available core in the destination cluster (CORE_A / self)
      // — that's the fallback when multi-core resolution can't pick
      // a specific target. Seed a non-available other core to confirm
      // it's not selected.
    });

    afterEach(async function () {
      await getPlatformDB().clearAll();
      if (rstSnapshot.length > 0) {
        await getPlatformDB().importAll(rstSnapshot);
      }
      await platform.registerSelf();
    });

    it('[MC16] assigns user-core to the single available core when restoring v1 register mappings', async function () {
      const { createBackupReader } = require('../../../storages/interfaces/backup/BackupReader');
      const RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator');
      // Build an in-memory reader with ONLY readServerMappings populated
      // (platform data empty; no users to restore here — we're testing
      // the register-mappings loop in isolation).
      const fakeMappings = [
        { username: 'rstuser1', server: 'co1.old-host.example' },
        { username: 'rstuser2', server: 'co1.old-host.example' }
      ];
      const reader = createBackupReader({
        async readManifest () { return { users: [], compressed: false }; },
        async * readPlatformData () { /* nothing */ },
        async readServerMappings () {
          async function * iter () { for (const m of fakeMappings) yield m; }
          return iter();
        },
        async openUser () { throw new Error('not used in this test'); },
        async close () { /* no-op */ }
      });

      const orchestrator = new RestoreOrchestrator();
      await orchestrator.init();
      await orchestrator._restorePlatform(reader);

      // Both users should be mapped to CORE_A (the sole available core)
      for (const u of ['rstuser1', 'rstuser2']) {
        const coreId = await platform.getUserCore(u);
        assert.strictEqual(coreId, CORE_A,
          `user-core/${u} should be mapped to ${CORE_A} (sole available core)`);
      }
    });
  });

  // ----------------------------------------------------------------
  // [MC-SVC] /service/info required fields + version
  // ----------------------------------------------------------------
  describe('[MC-SVC] /service/info', function () {
    let request;

    before(async function () {
      await setupMultiCore(CORE_A);
      config.injectTestConfig({
        dnsLess: { isActive: false },
        dns: { domain: DOMAIN },
        core: { id: CORE_A, ip: '10.0.0.1', hosting: 'us-east-1', available: true },
        service: {
          name: 'Test Service',
          serial: '2026042001',
          home: 'https://sw.' + DOMAIN,
          support: 'https://example.com/support',
          terms: 'https://example.com/terms',
          eventTypes: 'https://example.com/event-types.json'
        }
      });
      config.set('core:isSingleCore', false);
      config.set('core:url', buildCoreUrl(CORE_A));
      config.set('core:id', CORE_A);
      config.set('dns:domain', DOMAIN);
      // public-url.js config plugin is NOT loaded in the test boiler init
      // (tests use a minimal plugin set). Invoke it manually so `service.register`
      // / `service.access` reflect the current multi-core config instead of
      // whatever stale value boiler loaded from the service-info file.
      // Mirrors bin/master.js's plugin chain for a multi-core core.
      await require('../../../config/plugins/public-url').load(config);

      const app = getApplication(true);
      await app.initiate();
      // initiate() registers routes but not API methods (methods live in
      // server.js::registerApiMethods which runs in the worker boot path,
      // not in tests). Register service.info here so /reg/service/info
      // doesn't 404 with "invalid-method".
      require('../src/methods/service')(app.api);
      request = supertest(app.expressApp);
    });

    it('[MC17] /reg/service/info has all required fields', async function () {
      const res = await request.get('/reg/service/info');
      assert.strictEqual(res.status, 200);
      const b = res.body;
      for (const f of ['name', 'serial', 'home', 'support', 'terms', 'eventTypes', 'api', 'access', 'register']) {
        assert.ok(b[f], 'service/info must include `' + f + '` — got: ' + JSON.stringify(b));
      }
    });

    it('[MC18] /reg/service/info exposes `version` so SDKs pick the direct-core /users endpoint', async function () {
      const res = await request.get('/reg/service/info');
      assert.ok(res.body.version, 'version field must be present for lib-js ≥1.6.0 path selection');
    });

    it('[MC19] register/access URLs use reserved subdomains (reg.{domain}, access.{domain}) in multi-core mode', async function () {
      const res = await request.get('/reg/service/info');
      assert.ok(res.body.register.includes('reg.' + DOMAIN),
        'register URL should point at reg.{domain}: ' + res.body.register);
      assert.ok(res.body.access.includes('access.' + DOMAIN),
        'access URL should point at access.{domain}: ' + res.body.access);
    });
  });
});
