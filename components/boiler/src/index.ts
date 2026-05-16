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
   * Sync access to the fully-loaded configuration. Throws if boiler
   * init() hasn't been called or if async config-loading is still
   * pending. Use this from request/test paths that are guaranteed to
   * run post-init.
   */
  getConfigSync,
  /**
   * Escape hatch for pre-init reads. Returns the config object whether
   * or not async loading has completed; with `warnOnly: true`, prints
   * a warning instead of throwing when config is partial. Use only for
   * call sites that genuinely run before init resolves (e.g.
   * test-helpers fixture pre-computation, lazy-on-first-test-access
   * MongoDB Database constructor). Prefer `getConfigSync()` everywhere
   * else.
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

let logger: any;
let configInitialized = false;
let configInitCalledWithName: any = null;

function init (options: any, fullyLoadedCallback?: any) {
  if (configInitCalledWithName) {
    logger.warn('Skipping initalization! boiler is already initialized with appName: ' + configInitCalledWithName);
    return boiler;
  }

  // append the value of process.env.PRYV_BOILER_SUFFIX if present
  options.appNameWithoutPostfix = options.appName;
  if (process.env.PRYV_BOILER_SUFFIX) options.appName += process.env.PRYV_BOILER_SUFFIX;

  logging.setGlobalName(options.appName);
  configInitCalledWithName = options.appName;
  // Default `skipOverrideConfig` to true under NODE_ENV=test so a
  // developer's local config/override-config.yml (gitignored, used for
  // `NODE_ENV=development node bin/master.js`) does not bleed into any
  // test process — including child processes spawned by the
  // test-helpers SpawnContext, which inherit NODE_ENV from the parent.
  // Callers can still pass `skipOverrideConfig: false` to force the
  // load if they need it.
  const skipOverride = options.skipOverrideConfig !== undefined
    ? options.skipOverrideConfig === true
    : process.env.NODE_ENV === 'test';
  config.initSync({
    baseConfigDir: options.baseConfigDir,
    baseFilesDir: options.baseFilesDir,
    extras: options.extraConfigs,
    appName: options.appNameWithoutPostfix,
    skipOverrideConfig: skipOverride
  }, logging);

  logger = logging.getLogger('boiler');

  config.initASync().then((config: any) => {
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

/**
 * Sync access to the fully-loaded config. Throws if boiler hasn't been
 * init()'d or if async config-loading is still pending. Prefer this
 * over `getConfigUnsafe()` everywhere except the two known pre-init
 * sites (integrity fixture-time read, storage lazy MongoDB ctor).
 */
function getConfigSync () {
  if (!configInitCalledWithName) {
    throw (new Error('boiler must be initialized with init() before using getConfigSync()'));
  }
  if (!configInitialized) {
    throw (new Error('Config loaded before being fully initialized — use getConfigUnsafe(true) only if you genuinely need pre-init access'));
  }
  return config;
}

/**
 * Pre-init escape hatch. With `warnOnly: true` returns the partial
 * config + warns. Without (or with false) throws like `getConfigSync`.
 *
 * KEEP THIS for the two legitimate pre-init sites:
 *   - components/business/src/integrity/integrity.ts (module-top
 *     capture; test-helpers/data/events.ts fixture pre-computation
 *     races against boiler init).
 *   - components/storage/src/index.ts:_ensureMongoDatabase
 *     (test-helpers/dependencies lazy-loads MongoDB at module-load).
 *
 * Anywhere else, use `getConfigSync()`.
 */
function getConfigUnsafe (warnOnly?: any) {
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
export { boiler, getLogger, getConfig, getConfigSync, getConfigUnsafe, init };
export default boiler;
