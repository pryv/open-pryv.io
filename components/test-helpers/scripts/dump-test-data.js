/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Dumps test data into a `data` subfolder named after the provided version.
 * See `../src/data` for details.
 */

const path = require('path');
require('@pryv/boiler').init({
  appName: 'dump-test-data',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../config/'),
  extraConfigs: [
    {
      scope: 'serviceInfo',
      key: 'service',
      urlFromKey: 'serviceInfoUrl'
    },
    {
      scope: 'defaults-paths',
      file: path.resolve(__dirname, '../../../config/plugins/paths-config.js')
    },
    {
      pluginAsync: require(path.resolve(__dirname, '../../../config/plugins/systemStreams'))
    },
    {
      plugin: require(path.resolve(__dirname, '../../../config/plugins/public-url'))
    },
    {
      plugin: require(path.resolve(__dirname, '../../../config/plugins/config-validation'))
    }
  ]
});

const { getConfig } = require('@pryv/boiler');
const { fromCallback } = require('utils');

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
    await fromCallback(cb => testData.dumpCurrent(mongoFolder, version, cb));
  } catch (err) {
    console.error(err);
    hasErr = true;
  }
  process.exit(hasErr ? 1 : 0);
})();
