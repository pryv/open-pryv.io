#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// Operator tool: repair the `duration` of high-frequency series events written
// by releases before 2.0.0-rc.40.
//
// What it targets. Those releases wrote a series event's data extent in
// NANOSECONDS as its `duration` (seconds): one second of data gave a duration
// of 1,000,000,000 s. Such events match every later time-range query, many
// carry an integrity hash that does not verify, and later writes to the series
// can no longer correct them (the duration is only ever extended).
//
// What it does. For each local user, it reads the series events that end more
// than a day in the future (a duration written from stored data cannot end in
// the future), asks the series storage for each one's last point at or after
// the extent the stored value claims, and sets the duration to that point's
// deltaTime (seconds). An event whose series holds no point there is reported
// and left as is; an event whose data really reaches its duration is left as
// is. Writes go through the mall with `skipVersioning`: the integrity hash is
// recomputed, `modified` is refreshed (syncing clients fetch the corrected
// event), `modifiedBy` is kept. Version rows, where history is kept, are not
// rewritten.
//
// Usage:
//   node bin/hfs-duration-repair.js --dry-run              # report only
//   node bin/hfs-duration-repair.js                        # repair
//   node bin/hfs-duration-repair.js --user <username>      # one account only
//   node bin/hfs-duration-repair.js --config config/host-config.yml   # multi-core joiner
//
// Run once per core, after upgrading to 2.0.0-rc.40 or later. Safe to re-run.
// The core may be running.

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

const configFileArg = (() => {
  const i = process.argv.indexOf('--config');
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
})();
if (process.argv.includes('--config') &&
    (configFileArg == null || configFileArg.startsWith('-') ||
     !require('fs').existsSync(path.resolve(process.cwd(), configFileArg)))) {
  console.error(`--config: file not found: ${configFileArg ?? '(missing <file>)'}`);
  process.exit(1);
}

require('@pryv/boiler').init({
  appName: 'hfs-duration-repair',
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
    const seriesConnection = require('storages').seriesConnection;
    if (seriesConnection == null) {
      console.error('hfs-duration-repair: no series storage configured on this core: durations cannot be checked against the series data');
      process.exit(1);
    }
    const { getUsersLocalIndex } = require('storage');
    const { getMall } = require('mall');
    const business = require('business');
    const { seriesNamespace } = require('business/src/series/namespace.ts');
    const { repairUserSeriesDurations } = require('hfs-server/src/duration_repair.ts');

    const mall = await getMall();
    const usersIndex = await getUsersLocalIndex();
    const seriesRepo = new business.series.Repository(seriesConnection);

    const byUsername = await usersIndex.getAllByUsername(); // { username: userId }
    let usernames = Object.keys(byUsername);
    if (args.user != null) {
      if (byUsername[args.user] == null) {
        console.error('hfs-duration-repair: no such user on this core: ' + args.user);
        process.exit(1);
      }
      usernames = [args.user];
    }

    const now = Date.now() / 1000;
    const totals = { users: usernames.length, candidates: 0, repaired: 0, exact: 0, grown: 0, legit: 0, skippedChanged: 0 };
    const unexplained = [];
    const failed = [];
    for (const username of usernames) {
      const userId = byUsername[username];
      const r = await repairUserSeriesDurations({
        mall, seriesRepo, seriesNamespace: seriesNamespace(username), userId, username, now, dryRun: args.dryRun
      });
      totals.candidates += r.candidates;
      totals.repaired += r.repaired;
      totals.exact += r.exact;
      totals.grown += r.grown;
      totals.legit += r.legit;
      totals.skippedChanged += r.skippedChanged;
      unexplained.push(...r.unexplained);
      failed.push(...r.failed);
    }

    console.log('hfs-duration-repair: ' + (args.dryRun ? 'DRY-RUN (no writes)' : 'repair'));
    console.log('  users scanned                   ' + totals.users);
    console.log('  candidates                      ' + totals.candidates + '   (series events ending more than a day in the future)');
    console.log('  repaired                        ' + totals.repaired + (args.dryRun ? ' (would be)' : '') +
      '   [confirmed exact ' + totals.exact + ', series grew since ' + totals.grown + ']');
    console.log('  data extends to the duration    ' + totals.legit + '   (left as is)');
    console.log('  no series point at the extent   ' + unexplained.length + '   (left as is; listed below)');
    for (const entry of unexplained) console.log('    ' + entry);
    console.log('  check or write failed, skipped  ' + failed.length + '   (left as is; listed below with the error kind)');
    for (const entry of failed) console.log('    ' + entry);
    console.log('  changed under us, skipped       ' + totals.skippedChanged + '   (re-run to retry)');
    process.exit(0);
  } catch (err) {
    console.error('hfs-duration-repair: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function parseArgs (argv) {
  const args = { dryRun: false, user: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--user') { i++; args.user = argv[i]; } else if (a === '--config') { i++; /* consumed by boiler at init */ } else {
      console.error('Unknown option: ' + a);
      process.exit(1);
    }
  }
  if (args.user != null && args.user.length === 0) {
    console.error('--user needs a username');
    process.exit(1);
  }
  return args;
}

function printUsage (stream) {
  stream.write([
    'Repair the duration of high-frequency series events written by releases before',
    '2.0.0-rc.40 (it held the data extent in nanoseconds), from the series data.',
    '',
    'Usage:',
    '  node bin/hfs-duration-repair.js --dry-run            # report; do not write',
    '  node bin/hfs-duration-repair.js                      # repair',
    '  node bin/hfs-duration-repair.js --user <username>    # one account only',
    '',
    'On a multi-core joiner that layers a host-config file on top, pass it through:',
    '  node bin/hfs-duration-repair.js --config config/host-config.yml',
    '',
    'Run once per core, after upgrading. Safe to re-run. The core may be running.',
    'With the SQLite series engine, even a dry run creates the (empty) series file of an',
    'account that has a candidate event but no series data yet.',
    ''
  ].join('\n'));
}
