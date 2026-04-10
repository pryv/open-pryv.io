/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Phase 9: Multi-core acceptance tests.
 *
 * These tests inject multi-core config (dns:domain, core:id, hostings)
 * and seed PlatformDB with fake cores — no second instance needed.
 * Sequential because config injection affects shared state.
 *
 * IMPORTANT: We never call clearAll() on PlatformDB — that would destroy
 * user-unique/indexed entries for static test users (userzero etc.).
 * Instead, we only add core-info and user-core entries, which are
 * harmless for other tests (single-core mode ignores them).
 */

const assert = require('node:assert');
const supertest = require('supertest');
const cuid = require('cuid');
const charlatan = require('charlatan');

const { getConfig } = require('@pryv/boiler');
const { getApplication } = require('api-server/src/application');
const { platform } = require('platform');
const accessState = require('../src/routes/reg/accessState');

const DOMAIN = 'test-multicore.pryv.li';
const CORE_A = 'core-a';
const CORE_B = 'core-b';

function buildCoreUrl (coreId) {
  return 'https://' + coreId + '.' + DOMAIN;
}

describe('[RGMC] register: multi-core', function () {
  this.timeout(60000);

  let config;
  let savedIntegrityCheck;

  function getPlatformDB () {
    return require('storages').platformDB;
  }

  let savedPlatformData;

  before(async function () {
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    config = await getConfig();
    // Ensure storages are initialized
    const app = getApplication(true);
    await app.initiate();
    await platform.init();
    // Save user-unique/indexed entries. exportAll() also picks up user-core/
    // entries which parseEntry misinterprets — filter those out (username=undefined)
    const allData = await getPlatformDB().exportAll();
    savedPlatformData = allData.filter(e => e.username != null);
    // Clear stale core-info and user-core entries from previous test runs
    await getPlatformDB().clearAll();
    if (savedPlatformData.length > 0) {
      await getPlatformDB().importAll(savedPlatformData);
    }
  });

  after(async function () {
    // Clean up users created during multi-core tests
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    // Restore PlatformDB to pre-test state (user entries only, no core entries)
    await getPlatformDB().clearAll();
    if (savedPlatformData && savedPlatformData.length > 0) {
      await getPlatformDB().importAll(savedPlatformData);
    }
    // Re-register default 'single' core for subsequent tests
    restoreSingleCore();
    await platform.registerSelf();
    accessState.clear();
    // Restore integrity check
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  /**
   * Inject multi-core config and re-register self.
   */
  async function setupMultiCore (selfId, extra) {
    const inject = Object.assign({
      dnsLess: { isActive: false },
      dns: { domain: DOMAIN },
      core: {
        id: selfId,
        ip: '10.0.0.1',
        hosting: 'us-east-1',
        available: true
      }
    }, extra);
    config.injectTestConfig(inject);
    // core-identity plugin used config.set() at boot (highest nconf priority);
    // must also use config.set() to override
    config.set('core:isSingleCore', false);
    config.set('core:url', buildCoreUrl(selfId));
    config.set('core:id', selfId);
    config.set('dns:domain', DOMAIN);
    await platform.registerSelf();
    // Disable the default 'single' core entry (registered at Platform.init())
    // so it doesn't interfere with multi-core selection
    await getPlatformDB().setCoreInfo('single', {
      id: 'single', available: false
    });
  }

  /**
   * Seed a fake remote core in PlatformDB.
   */
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

  function restoreSingleCore () {
    config.injectTestConfig({});
    config.set('core:isSingleCore', true);
    config.set('core:url', null);
    config.set('dns:domain', null);
  }

  // ----------------------------------------------------------------
  // 1. Registration redirect: user assigned to remote core
  // ----------------------------------------------------------------
  describe('[MC01] registration redirect', function () {
    let request;
    let mc01Snapshot;

    before(async function () {
      // Snapshot PlatformDB before creating orphaned entries
      mc01Snapshot = (await getPlatformDB().exportAll()).filter(e => e.username != null);

      await setupMultiCore(CORE_A);
      await seedCore(CORE_B, { hosting: 'us-east-1' });
      // Give core-a some users so core-b is preferred
      await getPlatformDB().setUserCore('existing1', CORE_A);
      await getPlatformDB().setUserCore('existing2', CORE_A);

      const app = getApplication(true);
      await app.initiate();
      await require('../src/methods/auth/register')(app.api);
      request = supertest(app.expressApp);
    });

    afterEach(async function () {
      // Restore PlatformDB — redirect tests create orphaned unique field
      // reservations (user in PlatformDB but not in repository)
      await getPlatformDB().clearAll();
      if (mc01Snapshot.length > 0) {
        await getPlatformDB().importAll(mc01Snapshot);
      }
      // Re-seed cores for next test
      await platform.registerSelf();
      await seedCore(CORE_B, { hosting: 'us-east-1' });
      await getPlatformDB().setUserCore('existing1', CORE_A);
      await getPlatformDB().setUserCore('existing2', CORE_A);
    });

    after(restoreSingleCore);

    it('[MC01A] must return redirect when user is assigned to another core', async function () {
      const username = 'mc01a' + cuid.slug().toLowerCase();
      const res = await request.post('/users').send({
        appId: 'test-app',
        username,
        email: charlatan.Internet.email(),
        password: 'testpassword',
        insurancenumber: charlatan.Number.number(3)
      });
      assert.strictEqual(res.status, 201,
        'registration should succeed: ' + JSON.stringify(res.body));
      assert.ok(res.body.core, 'response must contain core object');
      assert.strictEqual(res.body.core.url, buildCoreUrl(CORE_B),
        'should redirect to core with fewest users');
      assert.ok(!res.body.apiEndpoint, 'should not return apiEndpoint for redirect');
    });

    it('[MC01B] must assign user-to-core mapping in PlatformDB', async function () {
      const username = 'mc01b' + cuid.slug().toLowerCase();
      await request.post('/users').send({
        appId: 'test-app',
        username,
        email: charlatan.Internet.email(),
        password: 'testpassword',
        insurancenumber: charlatan.Number.number(3)
      });
      const coreId = await platform.getUserCore(username);
      assert.strictEqual(coreId, CORE_B, 'user should be mapped to core-b');
    });
  });

  // ----------------------------------------------------------------
  // 2. /reg/cores multi-core: lookup returns correct core URL
  // ----------------------------------------------------------------
  describe('[MC02] GET /reg/cores multi-core', function () {
    let testUser;
    let request;

    before(async function () {
      await setupMultiCore(CORE_A);

      const app = getApplication(true);
      await app.initiate();
      await require('../src/methods/auth/register')(app.api);
      request = supertest(app.expressApp);

      // Seed user directly via usersRepository (avoid full HTTP registration)
      const { getUsersRepository, User } = require('business/src/users');
      const usersRepository = await getUsersRepository();
      testUser = 'mc02u' + cuid.slug().toLowerCase();
      const user = new User({
        username: testUser,
        email: charlatan.Internet.email(),
        password: 'testpassword',
        appId: 'test-app'
      });
      await usersRepository.insertOne(user, true);

      // Set user-core mapping to core-b
      await getPlatformDB().setUserCore(testUser, CORE_B);
    });

    after(restoreSingleCore);

    it('[MC02A] must return the correct core URL for a mapped user', async function () {
      const res = await request.get('/reg/cores')
        .query({ username: testUser });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.core);
      assert.strictEqual(res.body.core.url, buildCoreUrl(CORE_B));
    });

    it('[MC02B] must return error for unknown username', async function () {
      const res = await request.get('/reg/cores')
        .query({ username: 'nonexistent' + cuid.slug() });
      assert.strictEqual(res.status, 404);
    });
  });

  // ----------------------------------------------------------------
  // 3. /reg/hostings multi-core: regions with availability
  // ----------------------------------------------------------------
  describe('[MC03] GET /reg/hostings multi-core', function () {
    let request;

    before(async function () {
      await setupMultiCore(CORE_A, {
        hostings: {
          regions: {
            'north-america': {
              name: 'North America',
              zones: {
                'us-east': {
                  name: 'US East',
                  hostings: {
                    'us-east-1': { name: 'US East 1' },
                    'us-west-1': { name: 'US West 1' }
                  }
                }
              }
            }
          }
        }
      });
      await seedCore(CORE_B, { hosting: 'us-east-1' });
      // No cores in us-west-1

      const app = getApplication(true);
      await app.initiate();
      await require('../src/methods/auth/register')(app.api);
      request = supertest(app.expressApp);
    });

    after(restoreSingleCore);

    it('[MC03A] must return hostings with availability from PlatformDB', async function () {
      const res = await request.get('/reg/hostings');
      assert.strictEqual(res.status, 200);
      const regions = res.body.regions;
      assert.ok(regions['north-america']);
      const hostings = regions['north-america'].zones['us-east'].hostings;

      // us-east-1: core-a (self) + core-b → available
      assert.strictEqual(hostings['us-east-1'].available, true);
      assert.ok(hostings['us-east-1'].availableCore, 'must have availableCore URL');

      // us-west-1: no cores → not available
      assert.strictEqual(hostings['us-west-1'].available, false);
      assert.strictEqual(hostings['us-west-1'].availableCore, '');
    });
  });

  // ----------------------------------------------------------------
  // 4. /reg/access REDIRECTED flow
  // ----------------------------------------------------------------
  describe('[MC04] /reg/access REDIRECTED', function () {
    let request;

    before(async function () {
      const app = getApplication(true);
      await app.initiate();
      request = supertest(app.expressApp);
    });

    afterEach(() => {
      accessState.clear();
    });

    it('[MC04A] must accept REDIRECTED status with redirectUrl', async function () {
      const createRes = await request.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const redirectUrl = buildCoreUrl(CORE_B) + '/reg/access/' + key;
      const redirectRes = await request.post('/reg/access/' + key)
        .send({ status: 'REDIRECTED', redirectUrl });
      assert.strictEqual(redirectRes.status, 301);
      assert.strictEqual(redirectRes.body.status, 'REDIRECTED');
      assert.strictEqual(redirectRes.body.poll, redirectUrl);
    });

    it('[MC04B] poll must return REDIRECTED with new poll URL', async function () {
      const createRes = await request.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const redirectUrl = buildCoreUrl(CORE_B) + '/reg/access/newkey123';
      await request.post('/reg/access/' + key)
        .send({ status: 'REDIRECTED', redirectUrl });

      const pollRes = await request.get('/reg/access/' + key);
      assert.strictEqual(pollRes.status, 301);
      assert.strictEqual(pollRes.body.status, 'REDIRECTED');
      assert.strictEqual(pollRes.body.poll, redirectUrl);
    });

    it('[MC04C] must return 400 for REDIRECTED without redirectUrl', async function () {
      const createRes = await request.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const res = await request.post('/reg/access/' + key)
        .send({ status: 'REDIRECTED' });
      assert.strictEqual(res.status, 400);
    });
  });

  // ----------------------------------------------------------------
  // 5. selectCoreForRegistration: load balancing
  // ----------------------------------------------------------------
  describe('[MC05] selectCoreForRegistration', function () {
    beforeEach(async function () {
      await setupMultiCore(CORE_A);
    });

    after(restoreSingleCore);

    it('[MC05A] must return core with fewest users', async function () {
      // Use unique core IDs to avoid interference from other tests
      const cb = 'mc05a-b';
      const cc = 'mc05a-c';
      await seedCore(cb, { hosting: 'mc05-hosting' });
      await seedCore(cc, { hosting: 'mc05-hosting' });
      // core-a (self): many users from other tests; cb: 1 user; cc: 0 users
      await getPlatformDB().setUserCore('mc05u1', cb);

      const selected = await platform.selectCoreForRegistration('mc05-hosting');
      assert.strictEqual(selected, cc, 'should pick core with 0 users');
    });

    it('[MC05B] must filter by hosting', async function () {
      const cb = 'mc05b-east';
      const cc = 'mc05b-west';
      await seedCore(cb, { hosting: 'mc05b-east-h' });
      await seedCore(cc, { hosting: 'mc05b-west-h' });

      const selected = await platform.selectCoreForRegistration('mc05b-west-h');
      assert.strictEqual(selected, cc, 'should pick core in target hosting');
    });

    it('[MC05C] must fall back to self when no candidates match hosting', async function () {
      await seedCore('mc05c-b', { hosting: 'mc05c-east' });

      const selected = await platform.selectCoreForRegistration('mc05c-nonexistent');
      assert.strictEqual(selected, CORE_A, 'should fall back to self');
    });

    it('[MC05D] single-core always returns self', async function () {
      config.injectTestConfig({
        dnsLess: { isActive: true },
        core: { isSingleCore: true }
      });
      config.set('core:isSingleCore', true);
      const selected = await platform.selectCoreForRegistration(null);
      assert.strictEqual(selected, platform.coreId);
    });
  });

  // ----------------------------------------------------------------
  // 6. setAvailable: core availability toggling
  // ----------------------------------------------------------------
  describe('[MC06] setAvailable', function () {
    const MC06_CORE = 'mc06-peer';
    const MC06_HOSTING = 'mc06-hosting';

    before(async function () {
      await setupMultiCore(CORE_A);
      await seedCore(MC06_CORE, { hosting: MC06_HOSTING });
    });

    after(restoreSingleCore);

    it('[MC06A] must exclude unavailable core from registration selection', async function () {
      await getPlatformDB().setCoreInfo(MC06_CORE, {
        id: MC06_CORE,
        hosting: MC06_HOSTING,
        available: false
      });

      const selected = await platform.selectCoreForRegistration(MC06_HOSTING);
      assert.strictEqual(selected, CORE_A,
        'should not select unavailable core');
    });

    it('[MC06B] setAvailable(false) must update own core info', async function () {
      await platform.setAvailable(false);
      const info = await platform.getCoreInfo(CORE_A);
      assert.strictEqual(info.available, false);

      // Restore
      await platform.setAvailable(true);
      const restored = await platform.getCoreInfo(CORE_A);
      assert.strictEqual(restored.available, true);
    });
  });

  // ----------------------------------------------------------------
  // 7. /system/admin/cores
  // ----------------------------------------------------------------
  describe('[MC07] GET /system/admin/cores', function () {
    let request;

    before(async function () {
      config.set('auth:adminAccessKey', 'some_key_yo');
      await setupMultiCore(CORE_A);
      await seedCore(CORE_B, { hosting: 'us-east-1' });
      await getPlatformDB().setUserCore('mc07alice', CORE_A);
      await getPlatformDB().setUserCore('mc07bob', CORE_A);
      await getPlatformDB().setUserCore('mc07carol', CORE_B);

      const app = getApplication(true);
      await app.initiate();
      // Register system methods (not done by initiate — done by server.registerApiMethods)
      await require('../src/methods/system')(app.systemAPI, app.api);
      request = supertest(app.expressApp);
    });

    after(restoreSingleCore);

    it('[MC07A] must list cores with user counts', async function () {
      const adminToken = 'some_key_yo';
      const res = await request.get('/system/admin/cores')
        .set('Authorization', adminToken);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.cores));
      assert.ok(res.body.cores.length >= 2, 'should have at least 2 cores');

      const coreAInfo = res.body.cores.find(c => c.id === CORE_A);
      const coreBInfo = res.body.cores.find(c => c.id === CORE_B);
      assert.ok(coreAInfo, 'core-a must be listed');
      assert.ok(coreBInfo, 'core-b must be listed');
      // User counts include mc07-prefixed users mapped to each core
      assert.ok(coreAInfo.userCount >= 2, 'core-a should have >= 2 users');
      assert.ok(coreBInfo.userCount >= 1, 'core-b should have >= 1 user');
      assert.strictEqual(coreAInfo.url, buildCoreUrl(CORE_A));
      assert.strictEqual(coreBInfo.url, buildCoreUrl(CORE_B));
    });
  });

  // ----------------------------------------------------------------
  // 8. coreIdToUrl derivation
  // ----------------------------------------------------------------
  describe('[MC08] coreIdToUrl', function () {
    before(async function () {
      await setupMultiCore(CORE_A);
    });

    after(restoreSingleCore);

    it('[MC08A] must derive URL from coreId + domain', function () {
      assert.strictEqual(platform.coreIdToUrl(CORE_B),
        'https://' + CORE_B + '.' + DOMAIN);
    });

    it('[MC08B] must return own URL when no domain (single-core fallback)', function () {
      restoreSingleCore();
      const url = platform.coreIdToUrl('any-core');
      // In single-core mode with no domain, coreIdToUrl returns own coreUrl
      assert.notStrictEqual(url, 'https://any-core.' + DOMAIN);
    });
  });

  // ----------------------------------------------------------------
  // 9. Plan 27 Phase 2: wrong-core middleware on /:username/*
  // ----------------------------------------------------------------
  describe('[MC09] wrong-core middleware', function () {
    let request;

    before(async function () {
      await setupMultiCore(CORE_A);
      await seedCore(CORE_B, { hosting: 'us-east-1' });
      const app = getApplication(true);
      await app.initiate();
      request = supertest(app.expressApp);
      // Reset the lazy platform cache so the middleware uses the freshly
      // re-initialized singleton (multi-core mode).
      require('middleware/src/checkUserCore')._resetPlatformCache();
    });

    after(async function () {
      restoreSingleCore();
      // Restore the cached platform reference for subsequent test files.
      require('middleware/src/checkUserCore')._resetPlatformCache();
    });

    it('[MC09A] must return 421 wrong-core when user is hosted on a different core', async function () {
      const username = 'mc09-other-' + cuid.slug();
      await getPlatformDB().setUserCore(username, CORE_B);

      const res = await request.get('/' + username + '/events');
      assert.strictEqual(res.status, 421);
      assert.strictEqual(res.body.error.id, 'wrong-core');
      assert.strictEqual(res.body.error.coreUrl, buildCoreUrl(CORE_B));
      assert.match(res.body.error.message, new RegExp(username));
    });

    it('[MC09B] must let through requests for users hosted on this core', async function () {
      const username = 'mc09-self-' + cuid.slug();
      await getPlatformDB().setUserCore(username, CORE_A);

      const res = await request.get('/' + username + '/events');
      // Either 401 (no auth) or some other downstream error — the only thing
      // we care about is that 421 is NOT returned.
      assert.notStrictEqual(res.status, 421);
    });

    it('[MC09C] must let through requests for unknown users (no PlatformDB mapping)', async function () {
      const username = 'mc09-unknown-' + cuid.slug();
      // No setUserCore call — user is not in PlatformDB at all.
      const res = await request.get('/' + username + '/events');
      // Existing 401/404 paths handle unknown users; the middleware must NOT
      // return 421.
      assert.notStrictEqual(res.status, 421);
    });

    it('[MC09D] must skip /reg and /system routes', async function () {
      // /reg/cores is mounted outside /:username/* so the middleware never sees it.
      const res = await request.get('/reg/cores').query({ username: 'nonexistent-' + cuid.slug() });
      // The /reg/cores handler returns 404 for unknown user, NOT 421.
      assert.notStrictEqual(res.status, 421);
    });

    it('[MC09E] single-core mode must be a no-op', async function () {
      restoreSingleCore();
      // Re-init the application against single-core config.
      const app = getApplication(true);
      await app.initiate();
      const scRequest = supertest(app.expressApp);
      require('middleware/src/checkUserCore')._resetPlatformCache();
      // Even if PlatformDB has the user mapped to CORE_B, single-core mode
      // must NOT return 421 — there is only one core.
      const username = 'mc09e-' + cuid.slug();
      await getPlatformDB().setUserCore(username, CORE_B);
      const res = await scRequest.get('/' + username + '/events');
      assert.notStrictEqual(res.status, 421);
      // Restore multi-core for the rest of this describe block (after hook).
      await setupMultiCore(CORE_A);
      await seedCore(CORE_B, { hosting: 'us-east-1' });
      require('middleware/src/checkUserCore')._resetPlatformCache();
    });
  });

  // ----------------------------------------------------------------
  // 10. Plan 27 Phase 2: explicit core.url override (DNSless multi-core)
  // ----------------------------------------------------------------
  describe('[MC10] core.url override', function () {
    after(restoreSingleCore);

    it('[MC10A] coreIdToUrl must return the explicit URL when other core has core.url set', async function () {
      await setupMultiCore(CORE_A);

      // Simulate another core that registered with an explicit core.url
      // (e.g. https://api2.example.com — DNSless multi-core where DNS is
      // managed externally and FQDN is not derivable from {id}.{domain}).
      const explicitUrl = 'https://api2.example.com';
      await getPlatformDB().setCoreInfo(CORE_B, {
        id: CORE_B,
        url: explicitUrl,
        ip: null,
        ipv6: null,
        cname: null,
        hosting: 'us-east-1',
        available: true
      });
      // Refresh the in-memory cache that backs coreIdToUrl()
      await platform._refreshCoreUrlCache();

      const url = platform.coreIdToUrl(CORE_B);
      assert.strictEqual(url, explicitUrl);
    });

    it('[MC10B] coreIdToUrl must fall back to derivation when no explicit URL is registered', async function () {
      await setupMultiCore(CORE_A);

      // CORE_B registered without a url field — coreIdToUrl must derive
      // from id + domain.
      await getPlatformDB().setCoreInfo(CORE_B, {
        id: CORE_B,
        url: null,
        ip: null,
        ipv6: null,
        cname: null,
        hosting: 'us-east-1',
        available: true
      });
      await platform._refreshCoreUrlCache();

      const url = platform.coreIdToUrl(CORE_B);
      assert.strictEqual(url, 'https://' + CORE_B + '.' + DOMAIN);
    });

    it('[MC10C] wrong-core middleware must surface explicit URL in 421 response', async function () {
      await setupMultiCore(CORE_A);
      const explicitUrl = 'https://api3.example.com';
      await getPlatformDB().setCoreInfo(CORE_B, {
        id: CORE_B,
        url: explicitUrl,
        ip: null,
        ipv6: null,
        cname: null,
        hosting: 'us-east-1',
        available: true
      });
      await platform._refreshCoreUrlCache();

      const app = getApplication(true);
      await app.initiate();
      const request = supertest(app.expressApp);
      require('middleware/src/checkUserCore')._resetPlatformCache();

      const username = 'mc10c-' + cuid.slug();
      await getPlatformDB().setUserCore(username, CORE_B);

      const res = await request.get('/' + username + '/events');
      assert.strictEqual(res.status, 421);
      assert.strictEqual(res.body.error.coreUrl, explicitUrl);

      require('middleware/src/checkUserCore')._resetPlatformCache();
    });
  });
});
