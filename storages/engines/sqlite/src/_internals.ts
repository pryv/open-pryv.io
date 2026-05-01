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
  get userLocalDirectory (): any { return registry.userLocalDirectory; },
  get getEventFiles (): any { return registry.getEventFiles; },
  get createUserAccountStorage (): any { return registry.createUserAccountStorage; },
  get getLogger (): (name: string) => any { return registry.getLogger; },
  get config (): any { return registry.config; }
};
