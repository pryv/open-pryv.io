/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert');
const helpers = require('./helpers');
const validation = helpers.validation;
const methodsSchema = require('../src/schema/service-infoMethods');
const HttpServer = require('./support/httpServer');
const { getConfig } = require('@pryv/boiler');

const username = cuid();
let mongoFixtures;
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
    mongoFixtures = getNewFixture();
    await mongoFixtures.user(username, {});
  });

  after(async () => {
    await mongoFixtures.clean();
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
      // Strip response envelope (`meta`) and the new `version` field before
      // comparing the rest to the fixture.
      const { version, meta, ...rest } = res.body;
      assert.deepStrictEqual(rest, mockInfo);
      assert.ok(version, 'expected version field to be populated');
    });
  });
});
