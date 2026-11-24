/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Spawned by audit-lost-rows.test.js: a real cluster (master and two workers)
// with the lost audit records count on its real IPC channel. Each worker
// records its losses, the second one after the first has exited, then asks the
// master for the totals of the core. The answer is printed as one JSON line.

import cluster from 'node:cluster';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (cluster.isPrimary) {
  require('audit/src/lossAggregator.ts').attach(cluster);
  const first = cluster.fork({ ROLE: 'first' });
  first.on('exit', () => {
    const second = cluster.fork({ ROLE: 'second' });
    second.on('message', (msg) => {
      if (msg?.type !== 'result') return;
      process.stdout.write(JSON.stringify(msg.status) + '\n');
      second.kill();
      process.exit(0);
    });
  });
} else {
  const lossCounter = require('audit/src/lossCounter.ts');
  const { readLossStatus } = require('api-server/src/routes/auditStatusIpc.ts');
  if (process.env.ROLE === 'first') {
    lossCounter.record('valid', 'storage-write-failed');
    lossCounter.record('error', 'storage-write-failed');
    // Leaves once its messages have been handed over.
    process.send({ type: 'flushed' }, () => process.disconnect());
  } else {
    lossCounter.record('event', 'invalid-record');
    readLossStatus().then((status) => process.send({ type: 'result', status }));
  }
}
