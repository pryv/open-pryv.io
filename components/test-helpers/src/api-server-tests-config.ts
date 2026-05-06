/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require('path').dirname(__filename);

process.env.NODE_ENV = 'test';
const path = require('path');
require('@pryv/boiler').init({
  appName: 'boiler-tests',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../config/'),
  extraConfigs: [{
    scope: 'serviceInfo',
    key: 'service',
    urlFromKey: 'serviceInfoUrl'
  }, {
    scope: 'defaults-paths',
    file: path.resolve(__dirname, '../../../config/plugins/paths-config.js')
  }, {
    scope: 'default-audit-path',
    file: path.resolve(__dirname, '../../../config/plugins/default-path.js')
  }, {
    pluginAsync: require('../../../config/plugins/systemStreams')
  }]
});
