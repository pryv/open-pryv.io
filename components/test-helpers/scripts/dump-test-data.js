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
/**
 * Dumps test data into a `data` subfolder named after the provided version.
 * See `../src/data` for details.
 */

const path = require('path');
require('@pryv/boiler').init({
  appName: 'dump-test-data',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../api-server/config/'),
  extraConfigs: [
    {
      scope: 'serviceInfo',
      key: 'service',
      urlFromKey: 'serviceInfoUrl'
    },
    {
      scope: 'defaults-paths',
      file: path.resolve(__dirname, '../../api-server/config/paths-config.js')
    },
    {
      plugin: require(path.resolve(__dirname, '../../api-server/config/components/systemStreams'))
    },
    {
      plugin: require(path.resolve(__dirname, '../../api-server/config/public-url'))
    },
    {
      plugin: require(path.resolve(__dirname, '../../api-server/config/config-validation'))
    }
  ]
});

const { getConfig } = require('@pryv/boiler');
const bluebird = require('bluebird');

// don't add additional layer of ".." as this script is meant to be launched with babel-node as per the package.json script
// it does require the "ln -s ../components components" symlink in the root node_modules/ of the projet
const mongoFolder = path.resolve(__dirname, '../../../var-pryv/mongodb-bin');

const version = process.argv[2];
if (version == null) {
  console.error('Please provide version as first argument');
  process.exit(1);
}

(async () => {
  let hasErr = false;
  await getConfig();
  const testData = require('../src/data');
  try {
    await bluebird.fromCallback(cb => testData.dumpCurrent(mongoFolder, version, cb));
  } catch (err) {
    console.error(err);
    hasErr = true;
  }
  process.exit(hasErr ? 1 : 0);
})();
