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

let notifier = null;
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
  notifier = new EventEmitter();
  const originalEmit = notifier.emit.bind(notifier);
  notifier.emit = function (eventName, ...args) {
    originalEmit(eventName, ...args);
    if (typeof process.send === 'function') {
      try { process.send({ type: 'test-notification', event: eventName, data: args[0] }); } catch (e) { /* IPC channel closed */ }
    }
  };
  logger.info('Test notifier ready (IPC-based)');
  initializing = false;
  return notifier;
}

export { getTestNotifier };
