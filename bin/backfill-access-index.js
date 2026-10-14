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
//   - --prune: list (counts only) the index rows that name the wrong account:
//     no account on any core holds the stored name (orphan), or another
//     account of this core holds the access (stale: a later holder of a
//     renamed account's former name). Nothing is changed unless --apply is
//     given: then they are deleted (tombstoned under audit.onUserDelete:
//     keep). Rows whose access no account of this core holds any more
//     (missing: an access removed without a deletion record, an older backup
//     restored, or a former name taken again) are counted, never changed;
//     --list-missing prints them (access id, type, created, deleted) for
//     review. Run on every core (rows are judged by the name's home core).
//     Running --resync first gives every access held here its correct row,
//     which leaves no stale rows. The access map takes memory in proportion
//     to the core's accesses (about 60 MB per million).
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

    if (args.prune) {
      const { findPrunableAccessIndexRows, pruneAccessIndexRow } = require('platform/src/accessIndex.ts');
      // Every base access of every account of this core (deleted heads
      // included), read once: accessId -> userId.
      const holderOf = new Map();
      for (const username of usernames) {
        const userId = byUsername[username];
        const accesses = await fromCallback((cb) =>
          accessesStorage.findIncludingDeletionsAndVersions({ id: userId }, { headId: null }, null, cb));
        for (const access of (accesses || [])) if (access != null && access.id != null) holderOf.set(access.id, userId);
      }
      const rows = await findPrunableAccessIndexRows(platform, {
        coreId: platform.coreId,
        userCoreOf: (stored) => platform.getUserCoreByPreHashedUsername(stored),
        accessHolder: async (stored, accessId) => {
          const name = await platform.resolveLocalUsernameFromToken(stored);
          const userId = name != null ? byUsername[name] : null;
          if (userId == null) return null;
          const holder = holderOf.get(accessId);
          if (holder == null) return 'missing';
          return holder === userId ? 'owned' : 'other-account';
        }
      });
      const prunable = rows.filter((r) => r.reason !== 'missing');
      const keepMode = config.get('audit:onUserDelete') === 'keep';
      if (args.apply) for (const { key, entry } of prunable) await pruneAccessIndexRow(platform, key, entry, keepMode);
      console.log('backfill-access-index: prune ' + (args.apply ? (keepMode ? '(applied: tombstoned)' : '(applied: deleted)') : '(listing only; --apply to change)'));
      console.log('  orphan rows (no account holds the name)              ' + rows.filter((r) => r.reason === 'orphan').length);
      console.log('  stale rows (access held by another account here)     ' + rows.filter((r) => r.reason === 'stale').length);
      console.log('  missing rows (no account here holds the access;      ' + rows.filter((r) => r.reason === 'missing').length);
      console.log('    never pruned; --list-missing prints them)');
      if (args.listMissing) {
        for (const { entry } of rows.filter((r) => r.reason === 'missing')) {
          console.log(`    ${entry.accessId} type=${entry.type} created=${entry.created} deleted=${entry.deleted ?? '-'}`);
        }
      }
      process.exit(0);
    }

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
  const args = { resync: false, dryRun: false, prune: false, apply: false, listMissing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resync') args.resync = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--prune') args.prune = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--list-missing') args.listMissing = true;
    else if (a === '--config') { i++; /* file consumed by boiler at init */ } else {
      console.error('Unknown option: ' + a);
      process.exit(1);
    }
  }
  if ((args.apply || args.listMissing) && !args.prune) {
    console.error('--apply and --list-missing are only valid with --prune');
    process.exit(1);
  }
  return args;
}

function printUsage (stream) {
  stream.write([
    'Usage:',
    '  node bin/backfill-access-index.js            # write index rows that are absent',
    '  node bin/backfill-access-index.js --resync   # overwrite every row from access storage (repair)',
    '  node bin/backfill-access-index.js --dry-run  # report counts; do not write',
    '  node bin/backfill-access-index.js --prune    # count index rows naming the wrong account',
    '  node bin/backfill-access-index.js --prune --apply  # delete them (tombstone under audit keep)',
    '  node bin/backfill-access-index.js --prune --list-missing  # also print the rows never pruned',
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
