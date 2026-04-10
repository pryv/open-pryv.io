/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
process.env.NODE_ENV = 'test';
const path = require('path');
require('@pryv/boiler').init({
  appName: 'webhooks-test',
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
      plugin: require('../../../config/plugins/systemStreams')
    }
  ]
});
process.on('unhandledRejection', unhandledRejection);
// Handles promise rejections that aren't caught somewhere. This is very useful
// for debugging.
/**
 * @returns {void}
 */
function unhandledRejection (reason, promise) {
  console.warn(

    'Unhandled promise rejection:', promise, 'reason:', reason.stack || reason);
}

const storage = require('storage');

/**
 * Returns the webhooks storage instance (engine-agnostic).
 * @returns {Promise<any>}
 */
async function getWebhooksStorage () {
  const storageLayer = await storage.getStorageLayer();
  return storageLayer.webhooks;
}

module.exports = {
  getWebhooksStorage
};
