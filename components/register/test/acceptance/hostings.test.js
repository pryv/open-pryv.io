/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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
/* global describe, it, before, after */

require('test-helpers/src/api-server-tests-config');
const { context } = require('api-server/test/test-helpers');
const regPath = require('api-server/src/routes/Paths').Register;

const chai = require('chai');
const assert = chai.assert;
const expect = chai.expect;

describe('service', function () {
  let server;

  before(async () => {
    server = await context.spawn();
  });
  after(() => {
    server.stop();
  });

  it('[REA1] GET /service/info should receive service info data ', async function () {
    const res = await server
      .request()
      .get(regPath + '/service/info')
      .set('Accept', 'application/json');
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Pryv Lab');
    assert.equal(res.body.api, 'http://127.0.0.1:3000/{username}/');
  });

  it('[REA2] GET /apps should receive empty array ', async function () {
    const res = await server
      .request()
      .get(regPath + '/apps')
      .set('Accept', 'application/json');
    assert.equal(res.status, 200);
    expect(res.body).to.eql({ apps: [] });
  });

  it('[REA3] GET /apps/:appid should receive an dummy message ', async function () {
    const res = await server
      .request()
      .get(regPath + '/apps/toto')
      .set('Accept', 'application/json');
    assert.equal(res.status, 200);
    expect(res.body).to.eql({ app: { id: 'toto' } });
  });

  it('[REA4] GET /hostings should receive an hosting compatible message ', async function () {
    const res = await server
      .request()
      .get(regPath + '/hostings')
      .set('Accept', 'application/json');
    assert.equal(res.status, 200);
    expect(res.body).to.eql({
      regions: {
        region1: {
          name: 'region1',
          zones: {
            zone1: {
              name: 'zone1',
              hostings: {
                hosting1: {
                  url: 'https://sw.pryv.me',
                  name: 'Pryv.io',
                  description: 'Self hosted',
                  available: true,
                  availableCore: 'http://127.0.0.1:3000/'
                }
              }
            }
          }
        }
      }
    });
  });
});
