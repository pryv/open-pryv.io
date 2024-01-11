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

const { setTimeout } = require('timers/promises');
require('./test-helpers');
const HttpServer = require('./support/httpServer');
const { assert } = require('chai');
const hostname = require('os').hostname;
const cuid = require('cuid');

const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('./test-helpers');

const { getConfig } = require('@pryv/boiler');

let server;
let reportHttpServer;
let infoHttpServer;
const INFO_HTTP_SERVER_PORT = 5123;
const REPORT_HTTP_SERVER_PORT = 4001;
const CORE_ROLE = 'api-server';
const customSettings = {
  domain: 'test.pryv.com',
  reporting: {
    licenseName: 'pryv.io-test-license',
    templateVersion: '1.0.0'
  }
};
const monitoringUsername = cuid();
const monitorToken = cuid();

describe('service-reporting', () => {
  let mongoFixtures;
  before(async function () {
    mongoFixtures = databaseFixture(await produceMongoConnection());
    if ((await getConfig()).get('openSource:isActive')) this.skip();
  });
  after(async () => {
    await mongoFixtures.clean();
  });

  before(async () => {
    const user = await mongoFixtures.user(monitoringUsername);
    user.access({
      type: 'app', token: monitorToken
    });
    await mongoFixtures.user(cuid());
  });

  describe('POST report on service-reporting (started)', () => {
    let reportRecieved = false;
    before(async () => {
      infoHttpServer = new HttpServer('/service/info', 200);
      reportHttpServer = new HttpServer('/reports', 200);

      reportHttpServer.on('report_received', function () {
        reportRecieved = true;
      });

      await infoHttpServer.listen(INFO_HTTP_SERVER_PORT);
      await reportHttpServer.listen(REPORT_HTTP_SERVER_PORT);
      server = await context.spawn(customSettings);
    });

    after(async () => {
      server.stop();
      reportHttpServer.close();
    });

    it('[G1UG] must start and successfully send a report when service-reporting is listening', async () => {
      await setTimeout(1000);
      assert.isTrue(reportRecieved, 'Should have received report received event from server');
      await assertServerStarted();
      const lastReport = reportHttpServer.getLastReport();
      const reportingSettings = customSettings.reporting;

      assert.equal(lastReport.licenseName, reportingSettings.licenseName, 'missing or wrong licenseName');
      assert.equal(lastReport.role, CORE_ROLE, 'missing or wrong role');
      assert.equal(lastReport.templateVersion, reportingSettings.templateVersion, 'missing or wrong templatVersion');
      assert.equal(lastReport.hostname, hostname(), 'missing or wrong hostname');
      assert.isAbove(lastReport.clientData.userCount, 0, 'missing or wrong numUsers');
      assert.exists(lastReport.clientData.serviceInfoUrl, 'missing serviceInfourl');
    });
  });
});

async function assertServerStarted () {
  // throws if the server is off
  await server.request()
    .get(`/${monitoringUsername}/events`)
    .set('Authorizaiton', monitorToken);
}
