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
process.env.NODE_ENV = 'test';
process.on('unhandledRejection', unhandledRejection);
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('test-helpers');
// Handles promise rejections that aren't caught somewhere. This is very useful
// for debugging.
/**
 * @returns {void}
 */
function unhandledRejection (reason, promise) {
  logger.warn(
    // eslint-disable-line no-console
    'Unhandled promise rejection:', promise, 'reason:', reason.stack || reason);
}
// Set up a context for spawning api-servers.
const { SpawnContext } = require('test-helpers').spawner;
const context = new SpawnContext();

after(async () => {
  await context.shutdown();
});
const storage = require('storage');
const InfluxConnection = require('business/src/series/influx_connection');
// Produces and returns a connection to MongoDB.
/**
 * @returns {Promise<any>}
 */
async function produceMongoConnection () {
  return await storage.getDatabase();
}
/**
 * @param {any} settings
 * @returns {any}
 */
function produceInfluxConnection (settings) {
  const host = settings.get('influxdb:host');
  const port = settings.get('influxdb:port');
  return new InfluxConnection({ host, port });
}
module.exports = {
  context,
  produceMongoConnection,
  produceInfluxConnection
};
