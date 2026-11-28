/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

/**
 * [ADSM] the places the next administration features are written in, while
 * empty: the new configuration keys hold defaults that change nothing, the
 * per-area route and audit lists are empty and mounted, the validators of the
 * new keys report nothing, and the portal context and settings answer as
 * before.
 */

/* global initTests, initCore, coreRequest, assert */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

describe('[ADSM] administration seams: inert until filled', function () {
  this.timeout(60000);

  let config, adminKey;

  before(async function () {
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.setup.getStatus')) await require('api-server/src/methods/systemAdmin.ts').default(app.systemAPI);
    config = await require('@pryv/boiler').getConfig();
    adminKey = config.get('auth:adminAccessKey');
  });

  it('[ADSM1] default-config.yml holds the new keys with neutral defaults', () => {
    const defaults = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config/default-config.yml'), 'utf8'));
    assert.deepEqual(defaults.platform.configStore, { ignore: false, localOnly: [] });
    assert.deepEqual(defaults.portal.customCapabilities, []);
    assert.deepEqual(defaults.oauth.developerTerms, { url: null, version: null });
    assert.deepEqual(defaults.oauth.clientRegistration.limits, { appsPerAccount: 20, creationsPerDay: 5 });
    assert.equal(defaults.oauth.clientRegistration.mode, 'curated', 'registration stays curated');
  });

  it('[ADSM2] the new keys are classified, and none can be written to the platform store', () => {
    const { findRule } = require('business/src/effectiveConfig/classification.ts');
    const { SCHEMA } = require('business/src/platformConfig/schema.ts');
    const expected = {
      'platform.configStore.ignore': 'core',
      'platform.configStore.localOnly': 'core',
      'portal.customCapabilities': 'platform',
      'oauth.developerTerms.url': 'platform',
      'oauth.developerTerms.version': 'platform',
      'oauth.clientRegistration.limits.appsPerAccount': 'platform',
      'oauth.clientRegistration.limits.creationsPerDay': 'platform'
    };
    for (const [key, scope] of Object.entries(expected)) {
      assert.equal(findRule(key.split('.'))?.scope, scope, key);
      assert.equal(findRule(key.split('.'))?.class, 'public', key);
      assert.ok(!Object.keys(SCHEMA).some((k) => key === k || key.startsWith(k + '.')), key + ' is not in the store schema');
    }
  });

  it('[ADSM3] the validators of the new keys report nothing on the running configuration', () => {
    const { describeAdminConfig } = require('business/src/admin/config.ts');
    const { describeConfigStore } = require('business/src/platformConfig/localSwitch.ts');
    const { describeCustomCapabilities } = require('business/src/admin/capabilities.ts');
    const { describeDeveloperConfig } = require('oauth2/src/developer/config.ts');
    const { describeClientRegistrationConfig } = require('oauth2/src/clientValidation.ts');
    assert.deepEqual(describeConfigStore(config), { problems: [], warnings: [] });
    assert.deepEqual(describeCustomCapabilities(config), { problems: [], warnings: [] });
    assert.deepEqual(describeDeveloperConfig(config), { problems: [], warnings: [] });
    assert.deepEqual(describeAdminConfig(config).problems, []);
    // The registration block with its limits is accepted (no unknown key).
    const registration = describeClientRegistrationConfig(config.get('oauth:clientRegistration'));
    assert.deepEqual(registration.problems, []);
    // Still refused: a key that is not a setting.
    assert.ok(describeClientRegistrationConfig({ mode: 'curated', nope: 1 }).problems.some((p) => /nope is not a setting/.test(p)));
  });

  it('[ADSM4] the per-area lists are empty, and the route and method modules register nothing', async () => {
    const { INVITATION_ROUTES } = require('api-server/src/routes/systemRoutes/invitations.ts');
    const { OBSERVABILITY_ROUTES } = require('api-server/src/routes/systemRoutes/observability.ts');
    const { DNS_ROUTES } = require('api-server/src/routes/systemRoutes/dns.ts');
    for (const list of [INVITATION_ROUTES, OBSERVABILITY_ROUTES, DNS_ROUTES]) assert.deepEqual([...list], []);
    for (const area of ['adminOps', 'oauthApps']) {
      const lists = require('audit/src/apiMethods/' + area + '.ts');
      assert.deepEqual([...lists.all, ...lists.notAudited, ...lists.withoutUser], [], area);
    }
    const registered = [];
    const recorder = { register: (id) => registered.push(id) };
    await require('api-server/src/methods/systemAdminOps.ts').default(recorder);
    await require('api-server/src/methods/oauthApps.ts').default(recorder);
    const mounted = [];
    const express = { get: (p) => mounted.push(p), post: (p) => mounted.push(p), put: (p) => mounted.push(p), delete: (p) => mounted.push(p), use: (p) => mounted.push(p) };
    require('api-server/src/routes/system-admin-ops.ts').default(express, { systemAPI: { call () {} } });
    require('api-server/src/routes/oauthApps.ts').default(express, { api: { call () {} } });
    assert.deepEqual(registered, []);
    assert.deepEqual(mounted, []);
  });

  it('[ADSM5] the portal context offers the built-in capabilities only, with its usual fields', async () => {
    const { CAPABILITY_NAMES, offeredCapabilities, customCapabilities } = require('business/src/admin/capabilities.ts');
    const { withoutHiddenCapabilities } = require('business/src/admin/lockdown.ts');
    assert.deepEqual(customCapabilities(config), []);
    const res = await coreRequest.get('/system/admin/portal/context').set('authorization', adminKey);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ctx = res.body.portalContext;
    assert.ok(ctx.capabilities.every((c) => CAPABILITY_NAMES.includes(c)), 'no custom capability');
    assert.deepEqual(ctx.capabilities, withoutHiddenCapabilities(config, offeredCapabilities(config)));
    const known = ['core', 'setup', 'subject', 'capabilities', 'portal', 'adminSession', 'lockdown', 'localPolicy'];
    assert.deepEqual(Object.keys(ctx).filter((k) => !known.includes(k)), []);
  });

  it('[ADSM6] the public portal settings gain no field', async () => {
    const { PORTAL_CONTRACT } = require('business/src/admin/portalDefaults.ts');
    const { developerView } = require('oauth2/src/developer/config.ts');
    assert.deepEqual(developerView(config), {});
    const res = await coreRequest.get('/system/portal/settings');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { meta, ...body } = res.body;
    assert.ok(meta != null);
    assert.deepEqual(body, { contract: PORTAL_CONTRACT, spaces: ['admin', 'developer'], modules: { disabled: [], order: [] } });
  });
});
