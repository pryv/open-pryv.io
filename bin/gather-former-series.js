#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// Operator tool: bring the HF series of accounts renamed by earlier releases
// under their current username.
//
// What it targets. Series are kept in a namespace named after the username.
// Releases before the one that moves them on a username change left the
// points written before a change under the former username: they are no
// longer returned under either name (reads go to the current username's
// namespace), although they are still exported by the backup and erased with
// the account.
//
// What it does. For each local account, for each former username it holds
// (the `r-` aliases of accesses never hold series), it checks whether that
// namespace holds series and moves them into the namespace of the current
// username, merged (on a clash, the point already under the current username
// is kept; with InfluxDB, the moved one), then removes the former namespace:
// the same move a username change makes. A namespace holding nothing is left alone and nothing is
// created for it. Each namespace found is read once to count its points.
//
// Usage:
//   node bin/gather-former-series.js --dry-run            # report only
//   node bin/gather-former-series.js                      # move
//   node bin/gather-former-series.js --user <username>    # one account only
//   node bin/gather-former-series.js --config config/host-config.yml   # multi-core joiner
//
// Run once per core, after upgrading, once EVERY API and HF worker of the core
// runs the new release. Safe to re-run (a second run finds nothing to move).
// The core may be running, with this caveat (cached credentials): HF workers
// keep the series credentials of a name in a cache for a while. A worker of an
// earlier release, or one that cached a former name and missed the change
// notification, can still write under the former name during and after the
// move; those points are again not returned. A second run moves them, as does
// the account's next username change.

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
  appName: 'gather-former-series',
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
      console.error('gather-former-series: no series storage configured on this core: nothing to move');
      process.exit(1);
    }
    const { getUsersLocalIndex } = require('storage');
    const { gatherFormerSeries } = require('business/src/series/namespace.ts');
    const usersIndex = await getUsersLocalIndex();

    const byUsername = await usersIndex.getAllByUsername(); // { username: userId }
    let usernames = Object.keys(byUsername);
    if (args.user != null) {
      if (byUsername[args.user] == null) {
        console.error('gather-former-series: no such username on this core: ' + args.user);
        process.exit(1);
      }
      usernames = [args.user];
    }

    const found = [];
    const failed = [];
    for (const username of usernames) {
      try {
        for (const f of await gatherFormerSeries(seriesConnection, usersIndex, byUsername[username], username, args.dryRun)) {
          found.push({ username, ...f });
        }
      } catch (err) {
        failed.push(username + ': ' + ((err && err.message) || err));
      }
    }

    console.log('gather-former-series: ' + (args.dryRun ? 'DRY-RUN (no writes)' : 'move'));
    console.log('  accounts scanned                ' + usernames.length);
    console.log('  former namespaces with series   ' + found.length + (args.dryRun ? ' (would be moved)' : ' (moved)') + '   (listed below)');
    for (const f of found) {
      console.log('    "' + f.formerUsername + '" -> "' + f.username + '": ' + f.measurements + ' series, ' + f.points + ' points');
    }
    console.log('  failed, left as is              ' + failed.length + '   (re-run to retry)');
    for (const entry of failed) console.log('    ' + entry);
    process.exit(failed.length > 0 ? 2 : 0);
  } catch (err) {
    console.error('gather-former-series: ' + ((err && err.stack) || err));
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
    'Bring the HF series of accounts renamed by earlier releases under their current',
    'username: the series a username change left under a former username are moved',
    '(merged) into the namespace of the current one.',
    '',
    'Usage:',
    '  node bin/gather-former-series.js --dry-run            # report; do not write',
    '  node bin/gather-former-series.js                      # move',
    '  node bin/gather-former-series.js --user <username>    # one account only (current username)',
    '',
    'On a multi-core joiner that layers a host-config file on top, pass it through:',
    '  node bin/gather-former-series.js --config config/host-config.yml',
    '',
    'Run once per core, after upgrading, once every API and HF worker runs the new',
    'release. Safe to re-run. The core may be running, but HF workers cache the series',
    'credentials of a name for a while: a worker of an earlier release, or one that',
    'cached a former name and missed the change notification, can still write under',
    'the former name during and after the move. Those points are not returned until',
    'moved: a second run moves them (so does the account\'s next username change).',
    'Exit code 2 when an account failed (listed; re-run to retry).',
    ''
  ].join('\n'));
}
