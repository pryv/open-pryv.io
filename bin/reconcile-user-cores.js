#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: reconcile THIS core's slice of the shared name->core
// (`user-core/`) map with its local user index. Multi-core maintenance that
// heals the two drift states the platform-wide username availability check is
// sensitive to:
//
//   - STALE self-row: a `user-core/` row points at THIS core but no local
//     user or alias owns the name (every user ever deleted before the routing
//     map was cleaned left one, and single-core-era rows can too). Left alone,
//     the name reports "taken" platform-wide forever. This tool deletes them.
//   - MISSING self-row: a live local user or alias has no routing row (data
//     that predates the map, a partial restore). Left alone, another core can
//     claim the name and hijack routing, and the user is unreachable via the
//     cross-core lookup. This tool recreates them (atomic claim, so a name a
//     DIFFERENT core legitimately holds is never clobbered).
//
// Rows pointing at OTHER cores are NEVER touched: each core owns only its own
// slice, so run this once PER CORE. Single-core deployments are a no-op (the
// availability check ignores the map there). Idempotent; safe to re-run and to
// run against a live core.
//
// Usage:
//   node bin/reconcile-user-cores.js            # delete stale + heal missing
//   node bin/reconcile-user-cores.js --dry-run  # report counts; do not write
//   node bin/reconcile-user-cores.js --config config/host-config.yml

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

// Multi-core joiners carry their PG / storage-path config in a host-config file
// layered on top via `--config`, exactly as `bin/master.js` does. Load it here
// too so the tool reads the same authoritative storage the running core uses.
const configFileArg = (() => {
  const i = process.argv.indexOf('--config');
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
})();

require('@pryv/boiler').init({
  appName: 'reconcile-user-cores',
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
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();

    if (platform.isSingleCore) {
      console.log('reconcile-user-cores: single-core deployment — nothing to do ' +
        '(the platform-wide username check ignores the user-core map).');
      process.exit(0);
    }

    const summary = await usersRepository.reconcileUserCoreMap(args.dryRun);

    console.log('reconcile-user-cores: ' + (args.dryRun ? 'DRY-RUN (no writes)' : 'applied') +
      ' on core "' + platform.coreId + '"');
    console.log('  self-rows scanned       ' + summary.scanned);
    console.log('  other-core rows skipped ' + summary.skippedOtherCore);
    console.log('  stale rows deleted      ' + summary.deleted.length);
    console.log('  missing rows healed     ' + summary.healed.length);
    process.exit(0);
  } catch (err) {
    console.error('reconcile-user-cores: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function parseArgs (argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
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
    '  node bin/reconcile-user-cores.js            # delete stale + heal missing self-rows',
    '  node bin/reconcile-user-cores.js --dry-run  # report counts; do not write',
    '',
    'On a multi-core joiner that layers a host-config file (PG host, storage',
    'paths) on top, pass it through so the tool reads the same storage:',
    '  node bin/reconcile-user-cores.js --config config/host-config.yml',
    '',
    'Run once PER CORE (touches only rows that point at the core it runs on).',
    'Single-core deployments are a no-op. Safe to re-run and to run live.',
    ''
  ].join('\n'));
}
