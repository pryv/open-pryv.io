#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: populate the access reverse-index for accesses that predate
// it, AND repair divergence (a non-fatal index write that failed live, or a
// platform partition). Run per core — it reads THIS core's local per-user
// access storage and writes the cluster-wide index.
//
// Behaviour:
//   - Walks every local user, enumerates each user's base accesses INCLUDING
//     deleted heads (version snapshots are skipped — the index keys by base id).
//   - default (write-if-absent): only writes an index row that is ABSENT, so a
//     live mutation landing between this scan and its write is never clobbered
//     with stale data.
//   - --resync: OVERWRITE every row from the authoritative access storage. This
//     is the post-divergence repair mode (partition recovery, or after a
//     logged [access-index] live-write failure).
//   - --dry-run: report the counts without writing.
//
// Usage:
//   node bin/backfill-access-index.js            # write-if-absent
//   node bin/backfill-access-index.js --resync   # overwrite from storage
//   node bin/backfill-access-index.js --dry-run

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

// Multi-core joiners (e.g. a raw-deploy secondary core) carry their PG /
// storage-path config in a host-config file layered on top via `--config`,
// exactly as `bin/master.js` does. Load it here too so the backfill reads the
// same authoritative storage the running core uses.
const configFileArg = (() => {
  const i = process.argv.indexOf('--config');
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
})();

require('@pryv/boiler').init({
  appName: 'backfill-access-index',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../config/plugins/systemStreams')
  }, {
    plugin: require('../config/plugins/core-identity')
  }, ...(configFileArg != null
    ? [{ scope: 'host-config', file: path.resolve(process.cwd(), configFileArg) }]
    : [])]
});

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();

    await require('storages').init(config);
    const { getStorageLayer, getUsersLocalIndex } = require('storage');
    const storageLayer = await getStorageLayer();
    const accessesStorage = storageLayer.accesses;
    const usersIndex = await getUsersLocalIndex();
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    const { putAccessIndex, markAccessDeletedInIndex, getAccessIndex } = require('platform/src/accessIndex.ts');
    const { fromCallback } = require('utils');

    const byUsername = await usersIndex.getAllByUsername(); // { username: userId }
    const usernames = Object.keys(byUsername);

    const counts = { users: usernames.length, accesses: 0, written: 0, tombstoned: 0, skipped: 0 };

    for (const username of usernames) {
      const userId = byUsername[username];
      // All base heads (headId null) incl. deleted; version snapshots excluded.
      const accesses = await fromCallback((cb) =>
        accessesStorage.findIncludingDeletionsAndVersions({ id: userId }, { headId: null }, null, cb));
      for (const access of (accesses || [])) {
        if (access == null || access.id == null) continue;
        counts.accesses++;
        if (!args.resync) {
          const existing = await getAccessIndex(platform, access.id);
          if (existing != null) { counts.skipped++; continue; }
        }
        if (args.dryRun) { (access.deleted != null ? counts.tombstoned++ : counts.written++); continue; }
        if (access.deleted != null) {
          await markAccessDeletedInIndex(platform, username, access, access.deleted);
          counts.tombstoned++;
        } else {
          await putAccessIndex(platform, username, access);
          counts.written++;
        }
      }
    }

    console.log('backfill-access-index: ' + (args.dryRun ? 'DRY-RUN (no writes)' : (args.resync ? 'resync' : 'write-if-absent')));
    console.log('  users scanned      ' + counts.users);
    console.log('  accesses seen      ' + counts.accesses);
    console.log('  index rows written ' + counts.written);
    console.log('  tombstones written ' + counts.tombstoned);
    console.log('  skipped (present)  ' + counts.skipped);
    process.exit(0);
  } catch (err) {
    console.error('backfill-access-index: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function parseArgs (argv) {
  const args = { resync: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resync') args.resync = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--config') { i++; /* file consumed by boiler at init */ } else {
      console.error('Unknown option: ' + a);
      process.exit(1);
    }
  }
  return args;
}

function printUsage (stream) {
  stream.write([
    'Usage:',
    '  node bin/backfill-access-index.js            # write index rows that are absent',
    '  node bin/backfill-access-index.js --resync   # overwrite every row from access storage (repair)',
    '  node bin/backfill-access-index.js --dry-run  # report counts; do not write',
    '',
    'On a multi-core joiner that layers a host-config file (PG host, storage',
    'paths) on top, pass it through so the backfill reads the same storage:',
    '  node bin/backfill-access-index.js --config config/host-config.yml',
    '',
    'Run once per core (reads the core-local per-user access storage; writes the',
    'cluster-wide reverse-index). Safe to re-run; --resync is the repair mode.',
    ''
  ].join('\n'));
}
