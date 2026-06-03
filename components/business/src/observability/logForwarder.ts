/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Mirror boiler logger calls to the active observability provider,
 * gated by a configured log level.
 *
 * Default is `error` — only `logger.error(...)` calls ship to the
 * provider. Raising to `warn` / `info` / `debug` is operator opt-in
 * (costs events + may ship low-signal chatter).
 *
 * The forwarder is additive: boiler-level file + console logging is
 * unchanged. Errors always go to `provider.recordError`; lower-priority
 * records go to `provider.recordCustomEvent('PryvLog', ...)` which New
 * Relic stores as a queryable custom event.
 */

const observability = require('./index.ts');

type LogLevel = 'error' | 'warn' | 'info' | 'debug';
type LogFn = (msg: unknown, ...rest: unknown[]) => unknown;
type BoilerLogger = {
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
};

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let forwardLogLevel: LogLevel = 'error';

/**
 * Update the minimum log level forwarded to the provider.
 * Values outside the allowed set are clamped to `error`.
 */
function setLogLevel (level: string): void {
  forwardLogLevel = ((LEVEL_ORDER as Record<string, number>)[level] != null
    ? level
    : 'error') as LogLevel;
}

function shouldForward (level: string): boolean {
  if (!observability.isActive()) return false;
  const target = LEVEL_ORDER[forwardLogLevel];
  const event = (LEVEL_ORDER as Record<string, number>)[level];
  if (target == null || event == null) return false;
  return event <= target;
}

/**
 * Wrap an existing boiler logger so each level method forwards to the
 * provider before (or after) calling the original. Existing boiler
 * behaviour is preserved; this is a pure add-on.
 */
function wrap (logger: BoilerLogger, loggerName: string): BoilerLogger {
  const wrapped: BoilerLogger = Object.create(logger);

  wrapped.error = function (msg: unknown, ...rest: unknown[]): unknown {
    try {
      if (shouldForward('error')) {
        const err = msg instanceof Error ? msg : new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        observability.recordError(err, { logger: loggerName, extras: rest });
      }
    } catch { /* never let obs break logging */ }
    return logger.error(msg, ...rest);
  };

  for (const level of ['warn', 'info', 'debug'] as const) {
    wrapped[level] = function (msg: unknown, ...rest: unknown[]): unknown {
      try {
        if (shouldForward(level)) {
          observability.recordCustomEvent('PryvLog', {
            level,
            logger: loggerName,
            msg: typeof msg === 'string' ? msg : JSON.stringify(msg)
          });
        }
      } catch { /* idem */ }
      return logger[level](msg, ...rest);
    };
  }

  return wrapped;
}

// Test-only accessor.
const _getLogLevel = () => forwardLogLevel;
export { setLogLevel, shouldForward, wrap, _getLogLevel };
