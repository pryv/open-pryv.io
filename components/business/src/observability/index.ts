/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Provider-agnostic observability façade.
 *
 * Shape:
 *   - `init(providerId)` is called once at process start by the shim at
 *     `bin/_observability-boot.js`. If no provider is active, everything
 *     on this module is a cheap no-op.
 *   - Callers (business layer, LE renewer, auth flows) invoke the façade
 *     without knowing which provider is active. The goal is that adding
 *     a second provider in a future plan requires zero edits to business-
 *     layer code.
 *
 * Method set:
 *   - `isActive()`              — is a provider attached?
 *   - `setTransactionName(name)` — rename the current auto-instrumented
 *                                   transaction (route-pattern override).
 *   - `recordError(err, attrs)` — send an error to the provider's Error
 *                                   inbox.
 *   - `recordCustomEvent(type, attrs)` — queryable custom event.
 *   - `startBackgroundTransaction(name, fn)` — wrap `fn` as a named
 *                                   background transaction (LE renewer,
 *                                   cron-like work).
 */

let activeProvider = null; // {id, setTransactionName, recordError, recordCustomEvent, startBackgroundTransaction}

function init (provider) {
  if (activeProvider) {
    throw new Error('observability.init: a provider is already attached (' + activeProvider.id + ')');
  }
  activeProvider = provider;
}

function isActive () {
  return activeProvider !== null;
}

function setTransactionName (name) {
  if (!activeProvider) return;
  try { activeProvider.setTransactionName(name); } catch { /* never let obs break a request */ }
}

function recordError (err, attrs) {
  if (!activeProvider) return;
  try { activeProvider.recordError(err, attrs); } catch { /* idem */ }
}

function recordCustomEvent (type, attrs) {
  if (!activeProvider) return;
  try { activeProvider.recordCustomEvent(type, attrs); } catch { /* idem */ }
}

async function startBackgroundTransaction (name, fn) {
  if (!activeProvider) return fn();
  try {
    return await activeProvider.startBackgroundTransaction(name, fn);
  } catch (err) {
    // Provider failure must not mask the underlying operation's error.
    // If `fn` itself hasn't run yet (provider threw pre-dispatch), run it now.
    return fn();
  }
}

// Test-only: reset internal state between test runs.
function _reset () {
  activeProvider = null;
}

module.exports = {
  init,
  isActive,
  setTransactionName,
  recordError,
  recordCustomEvent,
  startBackgroundTransaction,
  _reset
};
