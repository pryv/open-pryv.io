/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 * Populated by the engine entry point's init() from barrel-provided values.
 * All engine files use require('./_internals.ts') or require('../_internals')
 * instead of host require() calls.
 */

interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface SqliteInternals {
  userLocalDirectory: unknown;
  getEventFiles: unknown;
  createUserAccountStorage: unknown;
  getLogger: (name: string) => Logger;
  config: unknown;
  storageLayer: unknown;
  cache: unknown;
  [k: string]: unknown;
}

const registry: Partial<SqliteInternals> = {};

const _internals = {
  set<K extends keyof SqliteInternals> (name: K, value: SqliteInternals[K]): void {
    (registry as SqliteInternals)[name] = value;
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
  get userLocalDirectory (): unknown { return registry.userLocalDirectory; },
  get getEventFiles (): unknown { return registry.getEventFiles; },
  get createUserAccountStorage (): unknown { return registry.createUserAccountStorage; },
  get getLogger (): (name: string) => Logger { return registry.getLogger!; },
  get config (): unknown { return registry.config; },
  get storageLayer (): unknown { return registry.storageLayer; },
  get cache (): unknown { return registry.cache; }
};

export { _internals };
export type { Logger, SqliteInternals };
