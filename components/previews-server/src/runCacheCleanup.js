/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Standalone script to perform cache cleanup.
 * Expects settings to be passed the same way as for the main server.
 */

const path = require('path');
const { getConfigUnsafe, getLogger } = require('@pryv/boiler').init({
  appName: 'previews-cache-clean',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../config/'),
  extraConfigs: [{
    scope: 'defaults-paths',
    file: path.resolve(__dirname, '../../../config/plugins/paths-config.js')
  }, {
    plugin: require('../../../config/plugins/systemStreams')
  }]
});

const Cache = require('./cache');
const errorHandling = require('errors').errorHandling;

const logger = getLogger('previews-cache-worker');
const config = getConfigUnsafe(true);
const previewsDirPath = config.get('storages:engines:filesystem:previewsDirPath');
const previewsCacheMaxAge = config.get('eventFiles:previewsCacheMaxAge') || 604800000; // 1 week in ms

const cache = new Cache({
  rootPath: previewsDirPath,
  maxAge: previewsCacheMaxAge / 1000, // convert ms to seconds
  logger
});

logger.info('Starting clean-up in ' + previewsDirPath);
cache.cleanUp()
  .then(() => {
    logger.info('Clean-up successful.');
    process.exit(0);
  })
  .catch(err => {
    errorHandling.logError(err, null, logger);
    process.exit(1);
  });
