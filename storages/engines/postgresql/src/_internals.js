/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 * Populated by the engine entry point's init() from barrel-provided values.
 * All engine files use require('./_internals') or require('../_internals')
 * instead of host require() calls.
 */
const registry = {};

module.exports = {
  set (name, value) { registry[name] = value; },
  /** Create a logger proxy that defers getLogger() until first use (safe at module scope). */
  lazyLogger (name) {
    let _log;
    const noop = () => {};
    return new Proxy({}, {
      get: (_, prop) => {
        if (!_log) {
          _log = registry.getLogger ? registry.getLogger(name) : { debug: noop, info: noop, warn: noop, error: noop };
        }
        const val = _log[prop];
        return typeof val === 'function' ? val.bind(_log) : val;
      }
    });
  },
  get databasePG () { return registry.databasePG; },
  get storageLayer () { return registry.storageLayer; },
  get getEventFiles () { return registry.getEventFiles; },
  get cache () { return registry.cache; },
  get createUserAccountStorage () { return registry.createUserAccountStorage; },
  get getLogger () { return registry.getLogger; },
  get config () { return registry.config; }
};
