/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

require('./test-helpers');
const cuid = require('cuid');
const helpers = require('./helpers');
const validation = helpers.validation;
const methodsSchema = require('../src/schema/service-infoMethods');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('./test-helpers');
const HttpServer = require('./support/httpServer');
const { getConfig } = require('@pryv/boiler');

const username = cuid();
let server;
let mongoFixtures;
let infoHttpServer;
let mockInfo;
const infoHttpServerPort = 5123;
describe('Service', () => {
  before(async () => {
    const config = await getConfig();
    mockInfo = config.get('service');

    infoHttpServer = new HttpServer('/service/info', 200, mockInfo);
    await infoHttpServer.listen(infoHttpServerPort);
    mongoFixtures = databaseFixture(await produceMongoConnection());
    await mongoFixtures.user(username, {});
    server = await context.spawn();
  });

  after(async () => {
    await mongoFixtures.clean();
    server.stop();
    infoHttpServer.close();
  });

  describe('GET /service/info', () => {
    it('[FR4K] must return all service info', async () => {
      const path = '/' + username + '/service/info';
      const res = await server.request().get(path);
      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result,
        body: mockInfo
      });
    });
  });
});
