/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Helper for forwarding test notifications via Node.js IPC.
 * IPC-based test notification forwarding via process.send().
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const EventEmitter = require('events');
const { getConfig, getLogger } = require('@pryv/boiler');

// The common contract consumers use — satisfied by both the no-op stub and a
// real EventEmitter. Event name is string|symbol (Node's type); `on`'s 2nd arg
// is a listener; only the event payload is genuinely arbitrary (Node types it
// `any[]` — we use the stricter `unknown[]`).
type TestNotifier = {
  emit: (eventName: string | symbol, ...args: unknown[]) => unknown;
  on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => unknown;
};
let notifier: TestNotifier | null = null;
let initializing = false;

async function getTestNotifier () {
  // eslint-disable-next-line no-unmodified-loop-condition
  while (initializing) { await new Promise((resolve) => setTimeout(resolve, 50)); }
  if (notifier != null) return notifier;
  initializing = true;
  const config = await getConfig();
  const settings = config.get('testNotifications');
  if (!settings || !settings.enabled) {
    notifier = { emit: () => {}, on: () => {} };
    initializing = false;
    return notifier;
  }
  const logger = getLogger('test-messaging');
  const emitter: TestNotifier = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = function (eventName: string | symbol, ...args: unknown[]) {
    const result = originalEmit(eventName, ...args);
    if (typeof process.send === 'function') {
      try { process.send({ type: 'test-notification', event: eventName, data: args[0] }); } catch (e) { /* IPC channel closed */ }
    }
    return result;
  };
  notifier = emitter;
  logger.info('Test notifier ready (IPC-based)');
  initializing = false;
  return notifier;
}

export { getTestNotifier };
