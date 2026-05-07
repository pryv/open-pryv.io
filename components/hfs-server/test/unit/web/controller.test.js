/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('test-helpers/src/api-server-tests-config.ts');
const assert = require('node:assert');

const controllerFactory = require('../../../src/web/controller.ts').default;
const controller = controllerFactory({});

const { APIError } = require('errors/src/APIError.ts');
const { ErrorIds } = require('errors/src/ErrorIds.ts');

describe('[HFCT] Controller', () => {
  describe('[HC01] storeSeriesData', () => {
    it('[3BYC] should reject queries if the authorization header is missing', (done) => {
      const req = {
        params: {},
        headers: {}
      };

      controller.storeSeriesData(req, {}, (err, res) => {
        assert.strictEqual(res, undefined);
        assert.ok(err);
        assert.ok(err instanceof APIError);
        assert.strictEqual(err.id, ErrorIds.MissingHeader);
        done();
      });
    });

    it('[U0WB] should reject queries if the eventId is missing', (done) => {
      const req = {
        params: {},
        headers: { authorization: 'token' }
      };

      controller.storeSeriesData(req, {}, (err, res) => {
        assert.strictEqual(res, undefined);
        assert.ok(err);
        assert.ok(err instanceof APIError);
        assert.strictEqual(err.id, ErrorIds.InvalidItemId);
        done();
      });
    });
  });
});
