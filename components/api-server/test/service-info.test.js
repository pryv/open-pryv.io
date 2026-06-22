/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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
  });
});
