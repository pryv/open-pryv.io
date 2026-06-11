/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 */

import type { Logger } from '@pryv/boiler';

interface PgInternals {
  databasePG: unknown;
  storageLayer: unknown;
  getEventFiles: unknown;
  cache: unknown;
  createUserAccountStorage: unknown;
  getLogger: (name: string) => Logger;
  config: unknown;
  [k: string]: unknown;
}

const registry: Partial<PgInternals> = {};

const _internals = {
  set<K extends keyof PgInternals> (name: K, value: PgInternals[K]): void {
    (registry as PgInternals)[name] = value;
  },
  /** Create a logger proxy that defers getLogger() until first use (safe at module scope). */
  lazyLogger (name: string): Logger {
    let _log: Logger | undefined;
    const noop = (): void => {};
    return new Proxy({}, {
      get: (_, prop: string) => {
        if (!_log) {
          _log = registry.getLogger
            ? registry.getLogger(name)
            : { debug: noop, info: noop, warn: noop, error: noop };
        }
        const val = (_log as unknown as Record<string, unknown>)[prop];
        return typeof val === 'function' ? val.bind(_log) : val;
      }
    }) as unknown as Logger;
  },
  get databasePG (): unknown { return registry.databasePG; },
  get storageLayer (): unknown { return registry.storageLayer; },
  get getEventFiles (): unknown { return registry.getEventFiles; },
  get cache (): unknown { return registry.cache; },
  get createUserAccountStorage (): unknown { return registry.createUserAccountStorage; },
  get getLogger (): (name: string) => Logger { return registry.getLogger!; },
  get config (): unknown { return registry.config; }
};

export { _internals };
export type { Logger, PgInternals };
