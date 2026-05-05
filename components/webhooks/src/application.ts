/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const path = require('path');
require('@pryv/boiler').init({
  appName: 'webhooks',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../config/'),
  extraConfigs: [
    {
      scope: 'serviceInfo',
      key: 'service',
      urlFromKey: 'serviceInfoUrl'
    },
    {
      pluginAsync: require('../../../config/plugins/systemStreams')
    }
  ]
});
const { getConfig, getLogger } = require('@pryv/boiler');
const accountStreams = require('business/src/system-streams');
const assert = require('assert');
const storage = require('storage');
const services = {
  WebhooksService: require('./service').WebhooksService
};

class Application {
  logger;

  settings;

  webhooksService;
  /**
   * @returns {Promise<void>}
   */
  async setup () {
    await this.initSettings();
    this.initLogger();
    assert(this.logger != null);
    assert(this.settings != null);
    this.logger.debug('setup done');
  }

  /**
   * @returns {Promise<void>}
   */
  async initSettings () {
    this.settings = await getConfig();
    await accountStreams.init();
  }

  /**
   * @returns {void}
   */
  initLogger () {
    this.logger = getLogger('application');
  }

  /**
   * @returns {Promise<void>}
   */
  async run () {
    const logger = this.logger;
    logger.info('Webhooks service is mounting services');
    const settings = this.settings;
    // Connect to MongoDB
    const storageLayer = await storage.getStorageLayer();
    // Construct the service
    const service = new services.WebhooksService({
      storage: storageLayer,
      logger: getLogger('webhooks_service'),
      settings
    });
    this.webhooksService = service;
    logger.info('run() done');
    // And start it.
    await service.start();
  }

  /**
   * @returns {void}
   */
  stop () {
    return this.webhooksService.stop();
  }
}
export { Application };
