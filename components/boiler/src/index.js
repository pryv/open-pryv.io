/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-boiler/blob/master/LICENSE)
 */

/**
 * Pryv Boiler module.
 * @module boiler
 */

const Config = require('./config');
const logging = require('./logging');

/** @type {Config} */
const config = new Config();

const boiler = {
  /**
   * get a Logger
   * @param {string} name
   * @returns {Logger}
   */
  getLogger: logging.getLogger,
  /**
   * Prefered way to get the configuration
   * @returns {Promise<Config>}
   */
  getConfig,
  /**
   * get the configuration.
   * If the configuration is not fully initialized throw an error
   * @param {boolean} warnOnly - Only warns about potential misuse of config
   * @returns {Config}
   */
  getConfigUnsafe,

  /**
   * Init Boiler, should be called just once when starting an APP
   * @param {Object} options
   * @param {string} options.appName - the name of the Application used by Logger and debug
   * @param {string} [options.baseConfigDir] - (optional) directory to use to look for configs
   * @param {Array<ConfigFile|ConfigRemoteURL|ConfigRemoteURLFromKey|ConfigPlugin>} [options.extraConfigs] - (optional) and array of extra files to load
   * @param {Function} [fullyLoadedCallback] - (optional) called when the config is fully loaded
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
    appName: options.appNameWithoutPostfix,
    learnDirectory: process.env.CONFIG_LEARN_DIR
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

module.exports = boiler;
