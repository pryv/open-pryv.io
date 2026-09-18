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
 * With DIM_FAKE_EXIT_EARLY set it exits 0 before announcing anything.
 */
const READY_DELAY_MS = 400;

if (process.env.DIM_FAKE_EXIT_EARLY) process.exit(0);
// With DIM_FAKE_IGNORE_SIGTERM set, only SIGKILL stops it.
if (process.env.DIM_FAKE_IGNORE_SIGTERM) process.on('SIGTERM', () => {});

// Never outlive the test process (e.g. if it is SIGKILLed).
process.on('disconnect', () => process.exit(0));
setTimeout(() => {
  process.send({ type: 'test-notification', event: 'test-server-ready' });
}, READY_DELAY_MS);
setInterval(() => {}, 1000);
