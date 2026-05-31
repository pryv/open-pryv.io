/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Entry point used by test-helpers/spawner.ts child_process.fork().

const Server = require('../../src/server.ts').default;
const { getApplication } = require('api-server/src/application.ts');
const ChildProcess = require('test-helpers').child_process;
const { getLogger, getConfig } = require('@pryv/boiler');
const logger = getLogger('child_process');

class ApplicationLauncher {
  app;
  constructor () {
    this.app = null;
  }

  /**
   * @param {any} injectSettings
   * @returns {Promise<any>}
   */
  async launch (injectSettings) {
    try {
      logger.debug('launch with settings', injectSettings);
      const config = await getConfig();
      // directly inject settings in nconf // to be updated to
      // TestServerContext.spawn copies the parent's effective storage
      // engine choice into `injectSettings.storages.{base,series,audit,
      // file}.engine` so the child inherits it without needing to read
      // STORAGE_ENGINE env at boot — env override would WIN over
      // injectTestConfig (memory > test scope) and force every spawned
      // child onto SQLite even when the parent (e.g. webhooks tests)
      // uses the PG default.
      config.injectTestConfig(injectSettings);
      const app = (this.app = getApplication());
      await app.initiate();
      const server = new Server();
      return server.start();
    } catch (e) {
      // this is necessary for debug process as Error is not forwarded correctly
      logger.error('Error during child_process.launch()', e);
      throw e; // foward error
    }
  }
}
const appLauncher = new ApplicationLauncher();
const clientProcess = new ChildProcess(appLauncher);
clientProcess.run();
