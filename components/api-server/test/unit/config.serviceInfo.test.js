/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const { getConfig } = require('@pryv/boiler');
const testServiceInfo = require('../../../../test/service-info.json');

describe('[SVIF] config: serviceInfo', () => {
  let config;
  before(async () => {
    config = await getConfig();
  });
  describe('[SI01] when dnsLess is disabled', () => {
    describe('[SI02] when "serviceInfoUrl" points to a file', () => {
      it('[D2P7] should load serviceInfo', () => {
        const serviceInfo = config.get('service');
        assert.deepEqual(serviceInfo, testServiceInfo);
      });
    });
  });
});
