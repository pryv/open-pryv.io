/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const loadAccessMiddleware = require('../../src/loadAccess');
const should = require('should');
const bluebird = require('bluebird');

describe('loadAccess middleware', function () {
  const loadAccess = loadAccessMiddleware();
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

  describe('when an access is actually loaded in request context', function () {
    it('[OD3D] should add the access id as Pryv-access-id header if token is valid', async function () {
      req.auth = 'valid';
      // Mocking req and res
      await bluebird.fromCallback(cb => loadAccess(req, res, cb));
      should(res.headers['Pryv-Access-Id']).be.eql('validAccess');
    });
    it('[UDW7] should still set the Pryv-access-id header in case of error (e.g. expired token)', async function () {
      req.auth = 'expired';
      try {
        // Mocking req and res
        await bluebird.fromCallback(cb => loadAccess(req, res, cb));
      } catch (err) {
        should.exist(err);
        should(res.headers['Pryv-Access-Id']).be.eql('expiredAccess');
      }
    });
  });
  describe('when the access can not be loaded (e.g. invalid token)', function () {
    it('[9E2D] should not set the Pryv-access-id header', async function () {
      req.auth = 'invalid';
      // Mocking req and res
      await bluebird.fromCallback(cb => loadAccess(req, res, cb));
      should.not.exist(res.headers['Pryv-Access-Id']);
    });
  });
});
