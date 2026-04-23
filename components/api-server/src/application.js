/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// A central registry for singletons and configuration-type instances; pass this
// to your code to give it access to app setup.

const path = require('path');
const { setTimeout } = require('timers/promises');

require('@pryv/boiler').init({
  appName: 'api-server',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../config/'),
  extraConfigs: [
    {
      scope: 'serviceInfo',
      key: 'service',
      urlFromKey: 'serviceInfoUrl'
    },
    {
      scope: 'default-paths',
      file: path.resolve(__dirname, '../../../config/plugins/paths-config.js')
    },
    {
      pluginAsync: require('../../../config/plugins/systemStreams')
    },
    {
      plugin: require('../../../config/plugins/core-identity')
    },
    {
      plugin: require('../../../config/plugins/public-url')
    },
    {
      scope: 'default-audit-path',
      file: path.resolve(__dirname, '../../../config/plugins/default-path.js')
    },
    {
      // pluginAsync (not plugin) so it runs AFTER `serviceInfoUrl` has been
      // fetched and `service.*` populated — otherwise the required-fields
      // check fires against an empty `service` scope.
      pluginAsync: require('../../../config/plugins/config-validation')
    },
    {
      plugin: {
        load: async () => {
          // this is not a plugin, but a way to ensure some component are initialized after config
          // @sgoumaz - should we promote this pattern for all singletons that need to be initialized ?
          const accountStreams = require('business/src/system-streams');
          await accountStreams.init();
        }
      }
    }
  ]
});

const storage = require('storage');
const API = require('./API');
const expressAppInit = require('./expressApp');
const middleware = require('middleware');
const errorsMiddlewareMod = require('./middleware/errors');

const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('application');
const userLocalDirectory = require('storage').userLocalDirectory;

const { ExtensionLoader } = require('utils').extension;

const { getAPIVersion } = require('middleware/src/project_version');
const { tracingMiddleware } = require('tracing');

logger.debug('Loading app');

/**
 * Application is a grab bag of singletons / system services with not many
 * methods of its own. It is the type-safe version of DI.
 */
class Application {
  // new config
  config;
  logging;

  initalized;
  initializing;

  /**
   * Normal user API
   * @type {API}
   */
  api;
  /**
   * API for system routes.
   * @type {API}
   */
  systemAPI;

  /** @type {import('storage').Database} */
  database;

  /**
   * Storage subsystem
   * @type {import('storage').StorageLayer}
   */
  storageLayer;

  expressApp;

  isAuditActive;

  constructor () {
    this.initalized = false;
    this.isAuditActive = false;
    this.initializing = false;
  }

  /**
   * @returns {Promise<this>}
   */
  async initiate () {
    while (this.initializing) {
      await setTimeout(50);
    }
    if (this.initalized) {
      logger.debug('App was already initialized, skipping');
      return this;
    }
    this.initializing = true;
    this.produceLogSubsystem();
    logger.debug('Init started');
    this.config = await getConfig();
    this.isAuditActive = this.config.get('audit:active');
    await userLocalDirectory.init();
    await require('storages').init(this.config);
    if (this.isAuditActive) {
      const audit = require('audit');
      await audit.init();
    }
    this.api = new API();
    this.systemAPI = new API();
    this.storageLayer = await storage.getStorageLayer();
    this.database = this.storageLayer.connection;
    await this.createExpressApp();
    const apiVersion = await getAPIVersion();
    const hostname = require('os').hostname();
    this.expressApp.use(tracingMiddleware('express1', {
      apiVersion,
      hostname
    }));
    await this.initiateRoutes();
    this.expressApp.use(middleware.notFound);
    const errorsMiddleware = errorsMiddlewareMod(this.logging);
    this.expressApp.use(errorsMiddleware);
    logger.debug('Init done');
    this.initalized = true;
    if (this.config.get('showRoutes')) { this.helperShowRoutes(); }
    this.initializing = false;
    return this;
  }

  /**
   * Helps that display all routes and methodId registered
   * @returns {void}
   */
  helperShowRoutes () {
    const routes = [];
    function addRoute (route) {
      if (route) {
        let methodId;
        for (const layer of route.stack) {
          if (layer.handle.name === 'setMethodId') {
            const fakeReq = {};
            layer.handle(fakeReq, null, function () { });
            methodId = fakeReq.context.methodId;
          }
        }
        let keys = Object.keys(route.methods);
        if (keys.length > 1) { keys = ['all']; }
        routes.push({ methodId, path: route.path, method: keys[0] });
      }
    }

    this.expressApp._router.stack.forEach(function (middleware) {
      if (middleware.route) {
        // routes registered directly on the app
        addRoute(middleware.route);
      } else if (middleware.name === 'router') {
        // router middleware
        middleware.handle.stack.forEach((h) => addRoute(h.route));
      }
    });
    console.log(routes);
  }

  /**
   * @returns {Promise<any>}
   */
  async createExpressApp () {
    this.expressApp = await expressAppInit(this.logging);
  }

  /**
   * @returns {Promise<void>}
   */
  async initiateRoutes () {
    // Register routes — always available (register functionality is built-in)
    require('./routes/register')(this.expressApp, this);
    require('./routes/reg/access')(this.expressApp, this);
    require('./routes/reg/records')(this.expressApp, this);
    require('./routes/reg/apps')(this.expressApp, this);
    require('./routes/reg/legacy')(this.expressApp, this);

    // system, root, register and delete MUST come first
    require('./routes/auth/delete')(this.expressApp, this);
    require('./routes/auth/register')(this.expressApp, this);

    require('./routes/system')(this.expressApp, this);
    require('./routes/root')(this.expressApp, this);

    require('./routes/accesses')(this.expressApp, this);
    require('./routes/account')(this.expressApp, this);
    require('./routes/auth/login')(this.expressApp, this);
    require('./routes/mfa')(this.expressApp, this);
    await require('./routes/events')(this.expressApp, this);
    require('./routes/profile')(this.expressApp, this);
    require('./routes/service')(this.expressApp, this);
    require('./routes/streams')(this.expressApp, this);

    require('./routes/webhooks')(this.expressApp, this);
    if (this.isAuditActive) {
      require('audit/src/routes/audit.route')(this.expressApp, this);
    }
  }

  /**
   * @returns {void}
   */
  produceLogSubsystem () {
    this.logging = getLogger('Application');
  }

  customAuthStepLoaded = false;
  customAuthStepFn = null;

  /**
   * Returns the custom auth function if one was configured. Otherwise returns
   * null.
   * @returns {CustomAuthFunction|null}
   */
  getCustomAuthFunction (from) {
    if (!this.customAuthStepLoaded) {
      this.customAuthStepFn = this.loadCustomExtension();
      this.customAuthStepLoaded = true;
    }
    logger.debug('getCustomAuth from: ' + from + ' => ' + (this.customAuthStepFn !== null), this.customAuthStep);
    return this.customAuthStepFn;
  }

  /**
   * @returns {Extension|null}
   */
  loadCustomExtension () {
    const defaultFolder = this.config.get('customExtensions:defaultFolder');
    const name = 'customAuthStepFn';
    const customAuthStepFnPath = this.config.get('customExtensions:customAuthStepFn');

    const loader = new ExtensionLoader(defaultFolder);

    let customAuthStep = null;
    if (customAuthStepFnPath) {
      logger.debug('Loading CustomAuthStepFn from ' + customAuthStepFnPath);
      customAuthStep = loader.loadFrom(customAuthStepFnPath);
    } else {
      // assert: no path was configured in configuration file, try loading from
      // default location:
      logger.debug('Trying to load CustomAuthStepFn from ' +
        defaultFolder +
        '/' +
        name +
        '.js');
      customAuthStep = loader.load(name);
    }
    if (customAuthStep) {
      logger.debug('Loaded CustomAuthStepFn');
      return customAuthStep.fn;
    } else {
      logger.debug('No CustomAuthStepFn');
    }
  }
}

let app;
/**
 * get Application Singleton
 * @param {boolean} forceNewApp - In TEST mode only, return a new Application for fixtures and mocks
 * @returns {any}
 */
function getApplication (forceNewApp) {
  if (forceNewApp || !app) {
    app = new Application();
  }
  return app;
}

module.exports = {
  getApplication
};

/**
 * @typedef {{
 *   ignoreProtectedFields: boolean;
 * }} UpdatesSettingsHolder
 */
