/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const loadAccessMiddleware = require('../../src/loadAccess');
const assert = require('node:assert');
const { promisify } = require('util');

describe('[LA01] loadAccess middleware', function () {
  const loadAccess = loadAccessMiddleware();
  const loadAccessAsync = promisify((req, res, cb) => loadAccess(req, res, cb));
  // Mocking request and response context/headers
  let req, res;
  beforeEach(async () => {
    req = {
      auth: 'invalid',
      context: {
        access: {},
        retrieveExpandedAccess: () => {
          if (req.auth === 'valid') {
            req.context.access = { name: 'Valid access', id: 'validAccess' };
          } else if (req.auth === 'expired') {
            req.context.access = {
              name: 'Expired access',
              id: 'expiredAccess'
            };
            throw new Error('Access is expired but should still be loaded!');
          } else {
            delete req.context.access;
          }
        }
      }
    };
    res = {
      headers: {},
      header: (key, value) => {
        res.headers[key] = value;
      }
    };
  });

  describe('[LA02] when an access is actually loaded in request context', function () {
    it('[OD3D] should add the access id as Pryv-access-id header if token is valid', async function () {
      req.auth = 'valid';
      // Mocking req and res
      await loadAccessAsync(req, res);
      assert.strictEqual(res.headers['Pryv-Access-Id'], 'validAccess');
    });
    it('[UDW7] should still set the Pryv-access-id header in case of error (e.g. expired token)', async function () {
      req.auth = 'expired';
      try {
        // Mocking req and res
        await loadAccessAsync(req, res);
      } catch (err) {
        assert.ok(err);
        assert.strictEqual(res.headers['Pryv-Access-Id'], 'expiredAccess');
      }
    });
  });
  describe('[LA03] when the access can not be loaded (e.g. invalid token)', function () {
    it('[9E2D] should not set the Pryv-access-id header', async function () {
      req.auth = 'invalid';
      // Mocking req and res
      await loadAccessAsync(req, res);
      assert.strictEqual(res.headers['Pryv-Access-Id'], undefined);
    });
  });
});
