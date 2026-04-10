/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const bluebird = require('bluebird');
const Application = require('../../src/application');
const { SeriesRowType, TypeRepository } = require('business').types;
const ChildProcess = require('test-helpers').child_process;
const { getConfig } = require('@pryv/boiler');
const typeRepo = new TypeRepository();

class ApplicationLauncher {
  app;
  constructor () {
    this.app = null;
  }

  // Gets called by the test process to mock out authentication and allow everyone
  // access.
  //
  /**
   * @param {boolean} allowAll
   * @returns {void}
   */
  mockAuthentication (allowAll) {
    const app = this.app;
    if (app == null) { throw new Error('AF: app should not be null anymore'); }
    const context = app.context;
    context.metadata = this.produceMetadataLoader(allowAll);
  }

  /**
   * @returns {any}
   */
  produceMetadataLoader (authTokenValid = true) {
    const seriesMeta = {
      canWrite: () => authTokenValid,
      canRead: () => authTokenValid,
      isTrashedOrDeleted: () => false,
      namespaceAndName: () => ['test', 'foo'],
      produceRowType: () => new SeriesRowType(typeRepo.lookup('mass/kg'))
    };
    return {
      forSeries: function forSeries () {
        return bluebird.resolve(seriesMeta);
      }
    };
  }

  // Replaces the metadata updater with a tracking noop stub.
  // Returns call info via the 'getMetadataUpdaterCalls' method.
  /**
   * @returns {void}
   */
  mockMetadataUpdater () {
    const app = this.app;
    if (app == null) { throw new Error('AF: app should not be null anymore'); }
    this._metadataUpdaterCalls = [];
    const calls = this._metadataUpdaterCalls;
    app.context.metadataUpdater = {
      scheduleUpdate: (req) => {
        calls.push(req);
        return Promise.resolve({});
      }
    };
  }

  /**
   * @returns {Array}
   */
  getMetadataUpdaterCalls () {
    return this._metadataUpdaterCalls || [];
  }

  /**
   * @returns {Promise<void>}
   */
  async launch (injectSettings = {}) {
    const config = await getConfig();
    config.injectTestConfig(injectSettings);
    const app = (this.app = new Application());
    await app.init();
    await app.start();
  }
}
const appLauncher = new ApplicationLauncher();
const childProcess = new ChildProcess(appLauncher);
childProcess.run();
process.on('SIGTERM', () => {
  // Delay actual exit for half a second, allowing our tracing code to submit
  // all traces to jaeger.
  setTimeout(() => process.exit(0), 100);
});
