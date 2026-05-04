/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


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

const observability = require('./index');

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3 };

let forwardLogLevel = 'error';

/**
 * Update the minimum log level forwarded to the provider.
 * Values outside the allowed set are clamped to `error`.
 */
function setLogLevel (level) {
  forwardLogLevel = LEVEL_ORDER[level] != null ? level : 'error';
}

function shouldForward (level) {
  if (!observability.isActive()) return false;
  const target = LEVEL_ORDER[forwardLogLevel];
  const event = LEVEL_ORDER[level];
  if (target == null || event == null) return false;
  return event <= target;
}

/**
 * Wrap an existing boiler logger so each level method forwards to the
 * provider before (or after) calling the original. Existing boiler
 * behaviour is preserved; this is a pure add-on.
 */
function wrap (logger, loggerName) {
  const wrapped = Object.create(logger);

  wrapped.error = function (msg, ...rest) {
    try {
      if (shouldForward('error')) {
        const err = msg instanceof Error ? msg : new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        observability.recordError(err, { logger: loggerName, extras: rest });
      }
    } catch { /* never let obs break logging */ }
    return logger.error(msg, ...rest);
  };

  for (const level of ['warn', 'info', 'debug']) {
    wrapped[level] = function (msg, ...rest) {
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

module.exports = {
  setLogLevel,
  shouldForward,
  wrap,
  // Test-only accessor.
  _getLogLevel: () => forwardLogLevel
};
