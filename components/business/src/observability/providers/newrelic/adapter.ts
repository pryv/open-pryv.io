/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * New Relic provider adapter.
 *
 * Wraps `require('newrelic')` behind the façade's method set. Only
 * required AFTER the agent has booted — the shim at
 * `bin/_observability-boot.js` calls `require('newrelic')` first, then
 * constructs this adapter.
 *
 * The `newrelicAgent` handle is injected rather than `require()`d here
 * so tests can pass a mock without touching the global agent.
 */

type NewRelicTransaction = { end?: () => void };
type NewRelicAgent = {
  setTransactionName: (name: string) => void;
  noticeError: (err: unknown, attrs?: Record<string, unknown>) => void;
  recordCustomEvent: (type: string, attrs?: Record<string, unknown>) => void;
  startBackgroundTransaction: (name: string, handler: () => Promise<void>) => void;
  getTransaction: () => NewRelicTransaction;
};

type ObservabilityAdapter = {
  id: string;
  setTransactionName: (name: string) => void;
  recordError: (err: unknown, attrs?: Record<string, unknown>) => void;
  recordCustomEvent: (type: string, attrs?: Record<string, unknown>) => void;
  startBackgroundTransaction: <T> (name: string, fn: () => T | Promise<T>) => Promise<T>;
};

function createAdapter (newrelicAgent: NewRelicAgent): ObservabilityAdapter {
  if (!newrelicAgent) {
    throw new Error('newrelic adapter: newrelicAgent is required');
  }
  return {
    id: 'newrelic',
    setTransactionName (name: string): void {
      newrelicAgent.setTransactionName(name);
    },
    recordError (err: unknown, attrs?: Record<string, unknown>): void {
      newrelicAgent.noticeError(err, attrs || {});
    },
    recordCustomEvent (type: string, attrs?: Record<string, unknown>): void {
      // New Relic insists event-type names be alphanumeric; callers should
      // stick to something like 'PryvLog' / 'PryvForward' / 'PryvBackup'.
      newrelicAgent.recordCustomEvent(type, attrs || {});
    },
    async startBackgroundTransaction<T> (name: string, fn: () => T | Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        newrelicAgent.startBackgroundTransaction(name, async () => {
          const tx = newrelicAgent.getTransaction();
          try {
            const result = await fn();
            resolve(result);
          } catch (err) {
            reject(err as Error);
          } finally {
            if (tx && typeof tx.end === 'function') tx.end();
          }
        });
      });
    }
  };
}

export { createAdapter };