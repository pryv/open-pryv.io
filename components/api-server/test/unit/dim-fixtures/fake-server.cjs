/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Stand-in for a spawned test server, driven by DynamicInstanceManager:
 * announces readiness over IPC after READY_DELAY_MS, then stays alive until
 * killed. Nothing listens: the tests only observe the readiness handshake.
 */
const READY_DELAY_MS = 400;

setTimeout(() => {
  process.send({ type: 'test-notification', event: 'test-server-ready' });
}, READY_DELAY_MS);
setInterval(() => {}, 1000);
