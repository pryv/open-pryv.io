/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


/**
 * Pryv Boiler module.
 * @module boiler
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { Config } = require('./config.ts');
const logging = require('./logging.ts');

/** @type {Config} */
const config = new Config();

const boiler = {
  /**
   * get a Logger
   */
  getLogger: logging.getLogger,
  /**
   * Prefered way to get the configuration
   */
  getConfig,
  /**
   * get the configuration.
   * If the configuration is not fully initialized throw an error
   * @param warnOnly - Only warns about potential misuse of config
   */
  getConfigUnsafe,

  /**
   * Init Boiler, should be called just once when starting an APP
   * @param options.appName - the name of the Application used by Logger and debug
   * @param [options.baseConfigDir] - (optional) directory to use to look for configs
   * @param [options.extraConfigs] - (optional) and array of extra files to load
   * @param [fullyLoadedCallback] - (optional) called when the config is fully loaded
   */
  init
};

let logger;
let configInitialized = false;
let configInitCalledWithName = null;

function init (options, fullyLoadedCallback) {
  if (configInitCalledWithName) {
    logger.warn('Skipping initalization! boiler is already initialized with appName: ' + configInitCalledWithName);
    return boiler;
  }

  // append the value of process.env.PRYV_BOILER_SUFFIX if present
  options.appNameWithoutPostfix = options.appName;
  if (process.env.PRYV_BOILER_SUFFIX) options.appName += process.env.PRYV_BOILER_SUFFIX;

  logging.setGlobalName(options.appName);
  configInitCalledWithName = options.appName;
  config.initSync({
    baseConfigDir: options.baseConfigDir,
    baseFilesDir: options.baseFilesDir,
    extras: options.extraConfigs,
    appName: options.appNameWithoutPostfix
  }, logging);

  logger = logging.getLogger('boiler');

  config.initASync().then((config) => {
    configInitialized = true;
    if (fullyLoadedCallback) fullyLoadedCallback(config);
  });

  return boiler;
}

async function getConfig () {
  if (!configInitCalledWithName) {
    throw (new Error('boiler must be initialized with init() before using getConfig()'));
  }
  /* eslint-disable-next-line no-unmodified-loop-condition */
  while (!configInitialized) {
    await new Promise(resolve => setTimeout(resolve, 100)); // wait 100ms
  }
  return config;
}

function getConfigUnsafe (warnOnly) {
  if (!configInitCalledWithName) {
    throw (new Error('boiler must be initialized with init() before using getConfigUnsafe()'));
  }
  if (!configInitialized) {
    if (warnOnly) {
      logger.warn('Warning! config loaded before being fully initialized');
    } else {
      throw (new Error('Config loaded before being fully initialized'));
    }
  }
  return config;
}

// Named exports so consumers using `const { getConfig, getLogger } =
// require('@pryv/boiler')` (and the deep `require('@pryv/boiler')` whole-
// module pattern) both keep working under Node 24 require(esm).
const { getLogger } = logging;
export { boiler, getLogger, getConfig, getConfigUnsafe, init };
export default boiler;
