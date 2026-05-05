/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 */

const registry: Record<string, any> = {};

const _internals = {
  set (name: string, value: any): void { registry[name] = value; },
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
  get database (): any { return registry.database; },
  get storageLayer (): any { return registry.storageLayer; },
  get getEventFiles (): any { return registry.getEventFiles; },
  get cache (): any { return registry.cache; },
  get createUserAccountStorage (): any { return registry.createUserAccountStorage; },
  get getLogger (): (name: string) => any { return registry.getLogger; },
  get config (): any { return registry.config; }
};

export { _internals };
