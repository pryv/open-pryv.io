/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 * Populated by the engine entry point's init() from barrel-provided values.
 * All engine files use require('./_internals.ts') instead of host require() calls.
 */

type LogFn = (...args: unknown[]) => void;
type Logger = { debug?: LogFn; info?: LogFn; warn?: LogFn; error?: LogFn; [k: string]: unknown };

const registry: Record<string, unknown> = {};

const _internals = {
  set (name: string, value: unknown): void { registry[name] = value; },
  /** Create a logger proxy that defers getLogger() until first use (safe at module scope). */
  lazyLogger (name: string): Logger {
    let _log: Logger | undefined;
    const noop = (): void => {};
    return new Proxy({}, {
      get: (_, prop: string) => {
        if (!_log) {
          const getLog = registry.getLogger as ((n: string) => Logger) | undefined;
          _log = getLog ? getLog(name) : { debug: noop, info: noop, warn: noop, error: noop };
        }
        const val = (_log as Record<string, unknown>)[prop];
        return typeof val === 'function' ? (val as Function).bind(_log) : val;
      }
    }) as Logger;
  },
  get getLogger () { return registry.getLogger; },
  get config () { return registry.config; }
};

export { _internals };
