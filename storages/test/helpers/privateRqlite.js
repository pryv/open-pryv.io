/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A private rqlited for the suites that need an empty platform store of their
 * own (they wipe it between tests): started on free ports with a data
 * directory of its own, stopped after. The rqlite the other suites use is
 * never touched. Needs `bin-ext/rqlited`, as the two-core suites do: without
 * it the suite fails (or is skipped with SKIP_2CORE=1, and says so).
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const rqliteProcess = require('../../engines/rqlite/src/rqliteProcess.ts');
const { requireRqlited } = require('test-helpers/src/requireRqlited.ts');

const RQLITE_BIN = path.resolve(__dirname, '../../../bin-ext/rqlited');

function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Call from a `before` hook with its mocha context. Answers the URL of the
 * private rqlited and a `stop()` to call from the matching `after` hook.
 */
export async function startPrivateRqlite (ctx, suite) {
  requireRqlited(RQLITE_BIN, ctx, suite);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqlite-private-'));
  const httpPort = await freePort();
  const raftPort = await freePort();
  const quiet = () => {};
  await rqliteProcess.start({
    coreId: 'private-store',
    binPath: RQLITE_BIN,
    dataDir,
    httpPort,
    raftPort,
    dnsDomain: null,
    coreIp: null,
    logFile: path.join(dataDir, 'rqlited.log'),
    log: quiet
  });
  return {
    url: 'http://127.0.0.1:' + httpPort,
    async stop () {
      await rqliteProcess.stop(quiet);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}
