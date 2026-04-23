/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 38 — New Relic provider adapter.
 *
 * This module wraps `require('newrelic')` behind the façade's method
 * set. It is only required AFTER the agent has booted (the shim at
 * `bin/_observability-boot.js` calls `require('newrelic')` first, then
 * constructs this adapter).
 *
 * The `newrelicAgent` handle is injected rather than `require()`d here
 * so tests can pass a mock without touching the global agent.
 */

function createAdapter (newrelicAgent) {
  if (!newrelicAgent) {
    throw new Error('newrelic adapter: newrelicAgent is required');
  }
  return {
    id: 'newrelic',
    setTransactionName (name) {
      newrelicAgent.setTransactionName(name);
    },
    recordError (err, attrs) {
      newrelicAgent.noticeError(err, attrs || {});
    },
    recordCustomEvent (type, attrs) {
      // New Relic insists event-type names be alphanumeric; callers should
      // stick to something like 'PryvLog' / 'PryvForward' / 'PryvBackup'.
      newrelicAgent.recordCustomEvent(type, attrs || {});
    },
    async startBackgroundTransaction (name, fn) {
      return new Promise((resolve, reject) => {
        newrelicAgent.startBackgroundTransaction(name, async () => {
          const tx = newrelicAgent.getTransaction();
          try {
            const result = await fn();
            resolve(result);
          } catch (err) {
            reject(err);
          } finally {
            if (tx && typeof tx.end === 'function') tx.end();
          }
        });
      });
    }
  };
}

module.exports = { createAdapter };
