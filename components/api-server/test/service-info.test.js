/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert');
const helpers = require('./helpers');
const validation = helpers.validation;
const methodsSchema = require('../src/schema/service-infoMethods.ts');
const HttpServer = require('./support/httpServer').default;
const { getConfig } = require('@pryv/boiler');
const { withInjectedConfig } = require('test-helpers');

const username = cuid();
let fixtures;
let infoHttpServer;
let mockInfo;
const infoHttpServerPort = 5123;
describe('[SINF] Service', () => {
  before(async () => {
    await initTests();
    await initCore();
    const config = await getConfig();
    mockInfo = config.get('service');

    infoHttpServer = new HttpServer('/service/info', 200, mockInfo);
    await infoHttpServer.listen(infoHttpServerPort);
    fixtures = getNewFixture();
    await fixtures.user(username, {});
  });

  after(async () => {
    await fixtures.clean();
    infoHttpServer.close();
  });

  describe('[SN01] GET /service/info', () => {
    it('[FR4K] must return all service info', async () => {
      const path = '/' + username + '/service/info';
      const res = await coreRequest.get(path);
      // `/service/info` now surfaces the API `version` field so SDKs can
      // branch on ≥1.6.0. Compare the base fields explicitly and let
      // `version` be present with any truthy value.
      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result
      });
      // Strip response envelope (`meta`), the new `version` field, and the
      // auto-derived `features` block (verified in [SN02]) before
      // comparing the rest to the fixture.
      const { version, meta, features, ...rest } = res.body;
      assert.deepStrictEqual(rest, mockInfo);
      assert.ok(version, 'expected version field to be populated');
    });

    it('[SN10] version, API-Version header and meta.apiVersion all agree with .api-version', async () => {
      // The three version surfaces must never diverge: all read the same
      // `.api-version` file (via project_version). Pins that a change to one
      // source does not silently leave the others reporting a different value,
      // and that the file the release build stamps is the value clients see.
      const fs = require('node:fs');
      const path = require('node:path');
      const versionFilePath = path.join(__dirname, '../../../', '.api-version');
      const fileVersion = fs.readFileSync(versionFilePath, { encoding: 'utf-8' });
      const res = await coreRequest.get('/' + username + '/service/info');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.version, fileVersion,
        'service/info.version must equal the .api-version file content');
      assert.strictEqual(res.headers['api-version'], fileVersion,
        'the API-Version response header must equal the .api-version file content');
      assert.strictEqual(res.body.meta && res.body.meta.apiVersion, fileVersion,
        'meta.apiVersion must equal the .api-version file content');
    });

    it('[SN03] advertises features.contentQueries=true', async () => {
      const path = '/' + username + '/service/info';
      const res = await coreRequest.get(path);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.features && res.body.features.contentQueries, true,
        'expected features.contentQueries=true');
    });

    it('[SN04] passes configured adapters[] through to /service/info', async () => {
      const adapters = ['https://{username}.pryv.me/adapter/calendar/'];
      await withInjectedConfig({ service: Object.assign({}, mockInfo, { adapters }) }, async () => {
        const res = await coreRequest.get('/' + username + '/service/info');
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.adapters, adapters);
      });
    });

    it('[SN02] auto-derives features.noHF=true when cluster.hfsWorkers===0', async () => {
      // Test-config defaults `cluster.hfsWorkers: 1`, so noHF is NOT
      // auto-derived in the [FR4K] response. Force the no-HF case by
      // injecting `cluster.hfsWorkers: 0` and re-querying.
      await withInjectedConfig({ cluster: { hfsWorkers: 0 } }, async () => {
        const path = '/' + username + '/service/info';
        const res = await coreRequest.get(path);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.features && res.body.features.noHF, true,
          'expected features.noHF=true when cluster.hfsWorkers===0');
      });
    });

    it('[SN11] advertises features.delegation from delegation.active; an explicit service.features.delegation wins', async () => {
      const get = async () => (await coreRequest.get('/' + username + '/service/info')).body.features.delegation;
      assert.strictEqual(await get(), true);
      await withInjectedConfig({ delegation: { active: false } }, async () => {
        assert.strictEqual(await get(), false);
      });
      await withInjectedConfig({ service: { features: { delegation: false } } }, async () => {
        assert.strictEqual(await get(), false);
      });
    });

    it('[SN12] serves service.account (the account app root) when configured, and the result schema accepts it', async () => {
      // The passthrough itself predates `account` (guard); the schema check
      // fails without `account` in the result schema.
      const plain = await coreRequest.get('/' + username + '/service/info');
      assert.ok(!('account' in plain.body), 'account must be absent unless configured');
      await withInjectedConfig({ service: { account: 'https://account.example.com' } }, async () => {
        const res = await coreRequest.get('/' + username + '/service/info');
        assert.strictEqual(res.body.account, 'https://account.example.com');
        validation.check(res, { status: 200, schema: methodsSchema.get.result });
      });
    });

    it('[SN05] advertises features.mfa.methods=["totp"] under the shipped default', async () => {
      const res = await coreRequest.get('/' + username + '/service/info');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.features && res.body.features.mfa, { methods: ['totp'] });
    });

    it('[SN06] advertises features.mfa.methods=[] (present, empty) when MFA is disabled', async () => {
      await withInjectedConfig({ services: { mfa: { active: false } } }, async () => {
        const res = await coreRequest.get('/' + username + '/service/info');
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.features && res.body.features.mfa, { methods: [] });
      });
    });

    it('[SN07] lists both methods, defaultMethod first, when SMS is also active', async () => {
      await withInjectedConfig({ services: { mfa: { active: true, defaultMethod: 'totp', methods: { totp: { active: true }, sms: { active: true } } } } }, async () => {
        const res = await coreRequest.get('/' + username + '/service/info');
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.features && res.body.features.mfa, { methods: ['totp', 'sms'] });
      });
    });

    it('[SN08] a legacy mode:single config advertises features.mfa.methods=["sms"] (upgrade path)', async () => {
      await withInjectedConfig({ services: { mfa: { mode: 'single', sms: { endpoints: { single: { url: 'x' } } } } } }, async () => {
        const res = await coreRequest.get('/' + username + '/service/info');
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.features && res.body.features.mfa, { methods: ['sms'] });
      });
    });

    it('[SN09] always advertises features.emailVerification { atRegistration, onAccount } from live config', async () => {
      const path = '/' + username + '/service/info';
      // Test config ships the gate off and verifyEmail explicitly false.
      const base = await coreRequest.get(path);
      assert.deepStrictEqual(base.body.features.emailVerification, {
        atRegistration: false,
        onAccount: false
      });
      // Flag on: the test config has the page URL and a complete mail setup.
      await withInjectedConfig({ services: { email: { enabled: { verifyEmail: true } } } }, async () => {
        const on = await coreRequest.get(path);
        assert.deepStrictEqual(on.body.features.emailVerification, {
          atRegistration: false,
          onAccount: true
        });
      });
      // Flag on but no landing page: the holder could not act on the link.
      await withInjectedConfig({
        services: { email: { enabled: { verifyEmail: true } } },
        auth: { emailVerificationPageURL: '' }
      }, async () => {
        const noUrl = await coreRequest.get(path);
        assert.strictEqual(noUrl.body.features.emailVerification.onAccount, false);
      });
      // The registration gate is advertised independently of the mail predicate.
      await withInjectedConfig({
        account: { emailVerification: { requireAtRegistration: true } }
      }, async () => {
        const gate = await coreRequest.get(path);
        assert.strictEqual(gate.body.features.emailVerification.atRegistration, true);
      });
    });
  });
});
