/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Load configuration in the following order (1st prevails)
 *
 * .0 'memory' -> empty, use when doing 'config.set()'
 * .1 'override-file' -> Loaded at from override-config.yml (if present;
 *                       skipped when `options.skipOverrideConfig: true`,
 *                       which the test harness sets so a developer's
 *                       local override-config.yml — gitignored, used by
 *                       NODE_ENV=development — does not bleed into test
 *                       expectations)
 * .2 'test' -> empty, used by test to override any other config parameter
 * .3 'argv' -> Loaded from arguments
 * .4 'env' -> Loaded from environement variables
 * .5 'base' -> Loaded from ${process.env.NODE_ENV}-config.yml (if present) or --config parameter
 * .6 and next -> Loaded from extras
 * .end
 *  . 'default-file' -> Loaded from ${baseDir}/default-config.yml
 *  . 'defaults' -> Hard coded defaults for logger
 */

const fs = require('fs');
const path = require('path');

const nconf = require('nconf');
nconf.formats.yaml = require('./lib/nconf-yaml.ts');

/**
 * Default values for Logger
 */
const defaults = {
  logs: {
    console: {
      active: true,
      level: 'info',
      format: {
        color: true,
        time: true,
        aligned: true,
        // emit one JSON object per line ({timestamp, level, name, pid,
        // message, context}) instead of human-readable text — for
        // log-based alerting / collectors. Overridable per-run with
        // LOG_FORMAT=json.
        json: false
      }
    },
    file: {
      active: true,
      path: 'application.log',
      rotation: {
        isActive: false
      }
    }
  }
};

type NconfStore = {
  use (scope: string, opts?: unknown): unknown;
  add (scope: string, opts: unknown): unknown;
  argv (opts?: unknown): NconfStore;
  env (opts?: unknown): NconfStore;
  file (scope: string, opts: unknown): unknown;
  defaults (def: unknown): unknown;
  get (key?: string): unknown;
  set (key: string, value: unknown): unknown;
  stores: Record<string, { type: string; file?: string; get (key?: string): unknown }>;
};
type Logger = {
  debug (msg: string, ...rest: unknown[]): void;
  warn (msg: string, ...rest: unknown[]): void;
  info (msg: string, ...rest: unknown[]): void;
  error (msg: string, ...rest: unknown[]): void;
};
type Logging = {
  getLogger (name: string): Logger;
  initLoggerWithConfig (config: unknown): void;
};
type ExtraDef = {
  scope: string;
  file?: string;
  plugin?: { load (config: unknown): string };
  pluginAsync?: { load (config: unknown): Promise<string> };
  data?: Record<string, unknown>;
  key?: string;
  url?: string;
  urlFromKey?: string;
  fileAsync?: string;
};
type InitOptions = {
  appName?: string;
  baseConfigDir?: string;
  baseFilesDir?: string;
  skipOverrideConfig?: boolean;
  extras?: ExtraDef[];
};

/**
 * Config manager
 */
class Config {
  store!: NconfStore;
  logger!: Logger;
  extraAsync: ExtraDef[];
  baseConfigDir: string | undefined;
  appName: string | undefined;
  baseFilesDir: string | undefined;

  constructor () {
    this.extraAsync = [];
  }

  /**
   * @private
   * Init Config with Files should be called just once when starting an APP
   * @param [options.baseConfigDir] - (optional) directory to use to look for configs (default, env)
   * @param [options.baseFilesDir] - (optional) directory to use for `file://` relative path
   * @param [options.extras] - (optional) and array of extra files or plugins to load (synchronously or async)
   */
  initSync (options: InitOptions, logging: Logging) {
    this.appName = options.appName;
    this.baseFilesDir = options.baseFilesDir || process.cwd();

    const logger = this.logger = logging.getLogger('config');
    const store = this.store = new nconf.Provider();

    const baseConfigDir = this.baseConfigDir = options.baseConfigDir || process.cwd();
    logger.debug('Init with baseConfigDir: ' + baseConfigDir);

    // 0. memory at top
    store.use('memory');

    // 1. eventual override-config.yml — skipped when the test harness
    // requests it (via `skipOverrideConfig: true`) so a developer's
    // local override-config.yml doesn't poison test expectations.
    if (options.skipOverrideConfig !== true) {
      loadFile('override-file', path.resolve(baseConfigDir, 'override-config.yml'));
    } else {
      logger.debug('Skipping override-config.yml (skipOverrideConfig: true)');
    }

    // 2. put a 'test' store up in the list that could be overwitten afterward and override other options
    // override 'test' store with store.add('test', {type: 'literal', store: {....}});
    store.use('test', { type: 'literal', store: {} });

    // get config from arguments and env variables
    // memory must come first for config.set() to work without loading config files
    // 3. `process.env`
    // 4. `process.argv`
    store.argv({ parseValues: true }).env({ parseValues: true, separator: '__' });

    // 5. Values in `${NODE_ENV}-config.yml` or from --config parameter
    let configFile;
    if (store.get('config')) {
      configFile = store.get('config') as string;
    } else if (store.get('NODE_ENV')) {
      configFile = path.resolve(baseConfigDir, store.get('NODE_ENV') + '-config.yml');
    }
    if (configFile) {
      loadFile('base', configFile);
    } else {
      // book 'base' slot
      store.use('base', { type: 'literal', store: {} });
      logger.debug('Booked [base] empty as no --config or NODE_ENV was set');
    }

    // load extra config files & plugins
    if (options.extras) {
      for (const extra of options.extras) {
        if (extra.file) {
          loadFile(extra.scope, extra.file);
          continue;
        }
        if (extra.plugin) {
          const name = extra.plugin.load(this);
          logger.debug('Loaded plugin: ' + name + ' ' + (extra.plugin.load as { then?: unknown }).then);
          continue;
        }
        if (extra.data) {
          const conf = extra.key ? { [extra.key]: extra.data } : extra.data;
          store.use(extra.scope, { type: 'literal', store: conf });
          logger.debug('Loaded [' + extra.scope + '] from DATA: ' + (extra.key ? ' under [' + extra.key + ']' : ''));
          continue;
        }
        if (extra.url || extra.urlFromKey || extra.fileAsync) {
          // register scope in the chain to keep order of configs
          store.use(extra.scope, { type: 'literal', store: {} });
          logger.debug('Booked [' + extra.scope + '] for async Loading ');
          this.extraAsync.push(extra);
          continue;
        }
        if (extra.pluginAsync) {
          logger.debug('Added 1 plugin for async Loading ');
          this.extraAsync.push(extra);
          continue;
        }
        logger.warn('Unkown extra in config init', extra);
      }
    }

    // .end-1 load default and custom config from configs/default-config.json
    loadFile('default-file', path.resolve(baseConfigDir, 'default-config.yml'));

    // .end load hard coded defaults
    store.defaults(defaults);

    // init Logger
    logging.initLoggerWithConfig(this);
    return this;

    // --- helpers --/

    function loadFile (scope: string, filePath: string) {
      if (fs.existsSync(filePath)) {
        if (filePath.endsWith('.js')) { // JS file
          const conf = require(filePath);
          store.use(scope, { type: 'literal', store: conf });
        } else { // JSON or YAML
          const options: Record<string, unknown> = { file: filePath };
          if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) { options.format = nconf.formats.yaml; }
          store.file(scope, options);
        }

        logger.debug('Loaded [' + scope + '] from file: ' + filePath);
      } else {
        logger.debug('Cannot find file: ' + filePath + ' for scope [' + scope + ']');
      }
    }
  }

  async initASync () {
    const store = this.store;
    const logger = this.logger;
    const baseConfigDir = this.baseConfigDir;
    const baseFilesDir = this.baseFilesDir;

    async function loadUrl (scope: string, key: string | undefined, url: string | undefined | null) {
      if (typeof url === 'undefined' || url === null) {
        logger.warn('Null or Undefined Url for [' + scope + ']');
        return;
      }

      let res = null;
      if (isFileUrl(url)) {
        res = loadFromFile(url, baseFilesDir);
      } else {
        res = await loadFromUrl(url);
      }
      const conf = key ? { [key]: res } : res;
      store.add(scope, { type: 'literal', store: conf });
      logger.debug('Loaded [' + scope + '] from URL: ' + url + (key ? ' under [' + key + ']' : ''));
    }

    // load remote config files
    for (const extra of this.extraAsync) {
      if (extra.url) {
        await loadUrl(extra.scope, extra.key, extra.url);
        continue;
      }
      if (extra.urlFromKey) {
        const url = store.get(extra.urlFromKey) as string | undefined | null;
        await loadUrl(extra.scope, extra.key, url);
        continue;
      }

      if (extra.pluginAsync) {
        const name = await extra.pluginAsync.load(this);
        logger.debug('Loaded async plugin: ' + name);
        continue;
      }

      if (extra.fileAsync) {
        const filePath = path.resolve(baseConfigDir, extra.fileAsync);

        if (!fs.existsSync(filePath)) {
          logger.warn('Cannot find file: ' + filePath + ' for scope [' + extra.scope + ']');
          continue;
        }
        if (!filePath.endsWith('.js')) {
          logger.warn('Cannot only load .js file: ' + filePath + ' for scope [' + extra.scope + ']');
          continue;
        }

        const conf = await require(filePath)();
        store.add(extra.scope, { type: 'literal', store: conf });

        logger.debug('Loaded in scope [' + extra.scope + ']async .js file: ' + filePath);
      }
    }

    logger.debug('Config fully Loaded');
    return this;
  }

  /**
   * Return true if key as value
   */
  has (key: string) {
    if (!this.store) { throw (new Error('Config not yet initialized')); }
    // Defined in any scope (no merge needed, see resolve()).
    return Object.values(this.store.stores).some((s) => typeof s.get(key) !== 'undefined');
  }

  /**
   * Retreive value
   * The returned value is a copy: mutating it does not change the config.
   * @param [key] if no key is provided all the config is returned
   */
  get (key?: string) {
    if (!this.store) { throw (new Error('Config not yet initialized')); }
    const value = resolve(this.store, key);
    if (typeof value === 'undefined') this.logger.debug('get: [' + key + '] is undefined');
    return value;
  }

  /**
   * Retreive value and store info that applies
   */
  getScopeAndValue (key: string): { value: unknown; scope: string; info: string } | null {
    if (!this.store) { throw (new Error('Config not yet initialized')); }
    for (const scopeName of Object.keys(this.store.stores)) {
      const store = this.store.stores[scopeName];
      const value = store.get(key);
      if (typeof value !== 'undefined') {
        const res: { value: unknown; scope: string; info: string } = {
          value: copyValue(value),
          scope: scopeName,
          info: ''
        };
        if (store.type === 'file') {
          res.info = 'From file: ' + store.file;
        } else {
          res.info = 'Type: ' + store.type;
        }
        return res;
      }
    }
    return null;
  }

  /**
   * Set value
   */
  set (key: string, value: unknown) {
    if (!this.store) { throw (new Error('Config not yet initialized')); }
    this.store.set(key, value);
  }

  /**
   * Inject Test Config and override any other option
   * @param configObject;
   */
  injectTestConfig (configObject: Record<string, unknown>) {
    this.replaceScopeConfig('test', configObject);
  }

  /**
   * Replace a scope config set
   * @param scope;
   * @param configObject;
   */
  replaceScopeConfig (scope: string, configObject: Record<string, unknown>) {
    if (!this.store) { throw (new Error('Config not yet initialized')); }
    this.logger.debug('Replace [' + scope + '] with: ', configObject);
    this.store.add(scope, { type: 'literal', store: configObject });
  }
}

export { Config };
export type { ExtraDef };

// --- value resolution across scopes ---- //

/**
 * Same resolution as nconf's `Provider.get()`: scopes are read from the highest
 * priority down to the first one holding a non-object value; the objects met on
 * the way are merged, higher scopes over lower ones, with nconf's own merge.
 *
 * Not delegated to nconf because its merge assigns the lowest scope's nested
 * objects BY REFERENCE into the result and then merges the higher scopes into
 * them: reading an object key wrote the values of a higher scope (e.g. an
 * injected test scope) into a lower one, where they outlived that scope. Here
 * each scope's value is copied before the merge, so no scope is ever written to
 * and the result shares nothing with the stores.
 */
function resolve (provider: NconfStore, key?: string): unknown {
  const objects: Record<string, unknown>[] = [];
  let found: unknown;
  for (const scope of Object.values(provider.stores)) {
    const value = scope.get(key);
    if (typeof value === 'undefined') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      objects.push(value as Record<string, unknown>);
      continue;
    }
    found = value;
    break;
  }
  if (objects.length === 0) return copyValue(found);
  const merged = new nconf.Memory();
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = copyValue(objects[i]) as Record<string, unknown>;
    for (const k of Object.keys(obj)) merged.merge(k, obj[k]);
  }
  return merged.store;
}

/**
 * Deep copy of plain objects and arrays; any other value (primitives, class
 * instances, functions) is returned as is.
 */
function copyValue (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) out[k] = copyValue((value as Record<string, unknown>)[k]);
  return out;
}

// --- remote and local json ressource loader ---- //

const FILE_PROTOCOL = 'file://';
const FILE_PROTOCOL_LENGTH = FILE_PROTOCOL.length;

async function loadFromUrl (url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`loadFromUrl: ${url} returned HTTP ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

function loadFromFile (fileUrl: string, baseFilesDir: string | undefined) {
  const filePath = stripFileProtocol(fileUrl);

  if (isRelativePath(filePath)) {
    fileUrl = path.resolve(baseFilesDir, filePath);
    fileUrl = 'file://' + fileUrl;
  } else {
    // absolute path, do nothing.
  }
  const res = JSON.parse(
    fs.readFileSync(stripFileProtocol(fileUrl), 'utf8')
  );
  return res;
}

function isFileUrl (filePath: string) {
  return filePath.startsWith(FILE_PROTOCOL);
}

function isRelativePath (filePath: string) {
  return !path.isAbsolute(filePath);
}

function stripFileProtocol (filePath: string) {
  return filePath.substring(FILE_PROTOCOL_LENGTH);
}

/**
 * @typedef ConfigFile
 * @property {string} scope - scope for nconf hierachical load
 * @property {string} file - the config file (.yml, .json, .js)
 */

/**
 * @typedef ConfigPlugin
 * @property {Object} plugin
 * @property {Function} plugin.load - a function that takes the "nconf store" as argument and returns the "name" of the plugin
 */

/**
 * @typedef ConfigData
 * @property {string} scope - scope for nconf hierachical load
 * @property {string} [key] - (optional) key to load result of url. If null loaded at root of the config
 * @property {object} data - the data to load

/**
 * @typedef ConfigRemoteURL
 * @property {string} scope - scope for nconf hierachical load
 * @property {string} [key] - (optional) key to load result of url. If null loaded at root of the config
 * @property {string} url - the url to the config definition
 */
/**
 * @typedef ConfigRemoteURLFromKey
 * @property {string} scope - scope for nconf hierachical load
 * @property {string} [key] - (optional) key to load result of url. If null override
 * @property {string} urlFromKey - retrieve url from config matching this key
 */
