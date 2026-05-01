/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 */

import type {} from 'node:fs';

const registry: Record<string, any> = {};

module.exports = {
  set (name: string, value: any): void { registry[name] = value; },
  /** Create a logger proxy that defers getLogger() until first use (safe at module scope). */
  lazyLogger (name: string): any {
    let _log: any;
    const noop = (): void => {};
    return new Proxy({}, {
      get: (_, prop: string) => {
        if (!_log) {
          _log = registry.getLogger ? registry.getLogger(name) : { debug: noop, info: noop, warn: noop, error: noop };
        }
        const val = _log[prop];
        return typeof val === 'function' ? val.bind(_log) : val;
      }
    });
  },
  get databasePG (): any { return registry.databasePG; },
  get storageLayer (): any { return registry.storageLayer; },
  get getEventFiles (): any { return registry.getEventFiles; },
  get cache (): any { return registry.cache; },
  get createUserAccountStorage (): any { return registry.createUserAccountStorage; },
  get getLogger (): (name: string) => any { return registry.getLogger; },
  get config (): any { return registry.config; }
};
