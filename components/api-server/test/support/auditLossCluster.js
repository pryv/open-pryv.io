/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Spawned by audit-lost-rows.test.js: a real cluster (master and two workers)
// with the lost audit records count on its real IPC channel. Each worker
// records its losses, the second one after the first has exited, then asks the
// master for the totals of the core. The first one also records losses once its
// channel is gone, which must not stop it. Each finding is one JSON line.

import cluster from 'node:cluster';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (cluster.isPrimary) {
  require('audit/src/lossAggregator.ts').attach(cluster);
  const first = cluster.fork({ ROLE: 'first' });
  first.on('exit', (exit, signal) => {
    process.stdout.write(JSON.stringify({ exit, signal }) + '\n');
    const second = cluster.fork({ ROLE: 'second' });
    second.on('message', (msg) => {
      if (msg?.type !== 'result') return;
      process.stdout.write(JSON.stringify({ status: msg.status }) + '\n');
      second.kill();
      process.exit(0);
    });
  });
} else {
  const lossCounter = require('audit/src/lossCounter.ts');
  const { readLossStatus } = require('api-server/src/methods/helpers/auditStatusIpc.ts');
  if (process.env.ROLE === 'first') {
    lossCounter.record('valid', 'storage-write-failed');
    lossCounter.record('error', 'storage-write-failed');
    // Disconnects once its messages have been handed over, and stays up.
    cluster.worker.exitedAfterDisconnect = true;
    process.once('disconnect', () => {
      const before = lossCounter.snapshot().lost.total;
      const connected = process.connected;
      lossCounter.record('valid', 'syslog-failed');
      // The same on a channel that closes between the check and the sending.
      Object.defineProperty(process, 'connected', { value: true });
      lossCounter.record('valid', 'syslog-failed');
      const late = lossCounter.snapshot().lost.total - before;
      // Leaves the time for an `error` event, which nothing handles here.
      setTimeout(() => process.stdout.write(JSON.stringify({ late, connected }) + '\n', () => process.exit(0)), 200);
    });
    process.send({ type: 'flushed' }, () => process.disconnect());
  } else {
    lossCounter.record('event', 'invalid-record');
    readLossStatus().then((status) => process.send({ type: 'result', status }));
  }
}
