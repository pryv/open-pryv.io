#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: reconcile THIS core's slice of the shared name->core
// (`user-core/`) map with its local user index. Heals the two drift states
// the platform-wide username availability check and the routing (the
// embedded DNS included) are sensitive to:
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
// slice, so run this once PER CORE. It applies on a single core too, where the
// embedded DNS (`dns.active`) answers every name through this map: aliases
// (`randomAlias` accesses) and usernames taken by a username change on a single
// core got no row before the release that writes them, so they answered
// NXDOMAIN; run it once after upgrading such a core. Idempotent and safe to
// re-run. Stale rows are deleted from one snapshot of the local index: a
// registration in flight during the run can lose its row, so run it with this
// core's API stopped, or run it again afterwards. An empty local index facing
// rows of this core is refused (exit 3, nothing written, dry run included)
// unless --force-empty-local: it usually means a lost index or a wrong
// --config, and deleting would unroute every name of the core.
//
// Usage:
//   node bin/reconcile-user-cores.js            # delete stale + heal missing
//   node bin/reconcile-user-cores.js --dry-run  # report counts; do not write
//   node bin/reconcile-user-cores.js --config config/host-config.yml
//
// With --ext-ids it reconciles this core's external ids instead (the `ext-id/`
// rows that point here against the core's local table): stale rows deleted,
// missing rows re-claimed, ids of deleted accounts released, ids another core
// holds dropped locally, ids of a deleted namespace reported. Run it after a
// restore, after a crash during a claim, before moving a core, and on EVERY
// core after a switch between cleartext and hashed mode (it first brings the
// local rows to the current tokens; add `--old-pepper <BASE64>` for the
// hashed-to-cleartext direction). It also applies on a single core. Unlike the
// username pass, run it with this core's API STOPPED: an id is a credential
// with competing claimants, and a claim or release in flight during the run
// can be undone by it (a second run with the API stopped repairs that). An
// empty local table facing rows of this core is refused (exit 3) unless
// --force-empty-local: it usually means the table was lost, and deleting the
// rows would free every id of the core.

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
// Boiler silently skips a missing file: refuse instead of reconciling the wrong storage.
if (process.argv.includes('--config') &&
    (configFileArg == null || configFileArg.startsWith('-') ||
     !require('fs').existsSync(path.resolve(process.cwd(), configFileArg)))) {
  console.error(`--config: file not found: ${configFileArg ?? '(missing <file>)'}`);
  process.exit(1);
}

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

    if (args.extIds) {
      const { getExternalIdsService } = require('business/src/external-ids/service.ts');
      const { getUsersLocalIndex } = require('storage');
      const usersIndex = await getUsersLocalIndex();
      const service = await getExternalIdsService();
      let oldHasher = null;
      if (args.oldPepper != null) {
        const { PiiHasher } = require('platform/src/PiiHasher.ts');
        oldHasher = new PiiHasher(args.oldPepper, config.get('platform:piiAlgorithm') || undefined);
      }
      const s = await service.reconcile({
        dryRun: args.dryRun,
        forceEmptyLocal: args.forceEmptyLocal,
        oldHasher,
        userExists: async (userId) => (await usersIndex.getNameForId(userId)) != null
      });
      console.log('reconcile-user-cores --ext-ids: ' + (args.dryRun ? 'DRY-RUN (no writes)' : 'applied') +
        ' on core "' + platform.coreId + '"');
      console.log('  local ids                 ' + s.localRows);
      console.log('  tokens refreshed          ' + s.refreshed);
      if (s.corruptTokens > 0) {
        console.log('  ! corrupt tokens          ' + s.corruptTokens + ' (a value token that does not match its blinded value)');
      }
      console.log('  stale rows deleted        ' + s.staleDeleted);
      console.log('  ids of deleted accounts   ' + s.orphanUsersReleased);
      console.log('  missing rows re-claimed   ' + s.missingHealed);
      console.log('  lost to another core      ' + s.lostToOtherCore);
      console.log('  namespace missing (kept)  ' + s.namespaceMissing);
      if (s.refusedEmptyLocal === true) {
        console.log('    ! REFUSED: this core\'s external-ids table is empty while the platform holds ids for ' +
          'this core. That is more likely a lost table (a partial restore, a wrong --config) than ids ' +
          'nobody holds, and deleting the rows would free every id of this core. Nothing was deleted. ' +
          'Check the core\'s storage; if the table is really meant to be empty, run again with --force-empty-local.');
        process.exit(3);
      }
      if (s.namespaceMissing > 0) {
        console.log('    ! some local ids match no namespace: after a pepper rotation or a switch from ' +
          'hashed to cleartext mode, run again with --old-pepper <retired pepper>; otherwise restore the ' +
          'namespace row (with its salt) from a backup, or release those ids');
      }
      process.exit(0);
    }

    const summary = await usersRepository.reconcileUserCoreMap(args.dryRun, { forceEmptyLocal: args.forceEmptyLocal });

    console.log('reconcile-user-cores: ' + (args.dryRun ? 'DRY-RUN (no writes)' : 'applied') +
      ' on core "' + platform.coreId + '"');
    console.log('  map rows scanned        ' + summary.scanned);
    console.log('  other-core rows skipped ' + summary.skippedOtherCore);
    console.log('  self-rows (this core)   ' + (summary.scanned - summary.skippedOtherCore));
    console.log('  stale rows deleted      ' + summary.deleted.length);
    console.log('  missing rows healed     ' + summary.healed.length);
    console.log('  conflicts (unhealable)  ' + summary.conflicts.length);
    for (const c of summary.conflicts) {
      console.log('    ! "' + c.username + '" is owned locally but routed to ' + c.coreId +
        ' — resolve by hand (this tool never overwrites another core\'s claim)');
    }
    if (summary.refusedEmptyLocal === true) {
      console.log('    ! REFUSED: this core\'s users index is empty while the platform routes names to ' +
        'this core. That is more likely a lost index (a partial restore, a wrong --config) than a core ' +
        'with no account left, and deleting the rows would unroute every name of this core. Nothing was ' +
        'deleted. Check the core\'s storage; if the index is really meant to be empty, run again with ' +
        '--force-empty-local.');
      process.exit(3);
    }
    process.exit(0);
  } catch (err) {
    console.error('reconcile-user-cores: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function parseArgs (argv) {
  const args = { dryRun: false, extIds: false, oldPepper: null, forceEmptyLocal: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--ext-ids') args.extIds = true;
    else if (a === '--force-empty-local') args.forceEmptyLocal = true;
    else if (a === '--old-pepper') {
      args.oldPepper = argv[++i];
      if (args.oldPepper == null || args.oldPepper.startsWith('-')) {
        console.error('--old-pepper: missing <BASE64>');
        process.exit(1);
      }
    } else if (a === '--config') { i++; /* file consumed by boiler at init */ } else {
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
    '  node bin/reconcile-user-cores.js --force-empty-local',
    '                                              # allow deleting this core\'s rows when its',
    '                                              # users index is empty (refused, exit 3, otherwise)',
    '  node bin/reconcile-user-cores.js --ext-ids [--old-pepper <BASE64>] [--dry-run]',
    '                                              # reconcile this core\'s external ids',
    '                                              # (--old-pepper: the retired pepper, after',
    '                                              # a rotation or a hashed-to-cleartext switch;',
    '                                              # run with this core\'s API stopped;',
    '                                              # --force-empty-local: allow deleting this',
    '                                              # core\'s rows when its local table is empty)',
    '',
    'On a multi-core joiner that layers a host-config file (PG host, storage',
    'paths) on top, pass it through so the tool reads the same storage:',
    '  node bin/reconcile-user-cores.js --config config/host-config.yml',
    '',
    'Run once PER CORE (touches only rows that point at the core it runs on).',
    'Applies on a single core too. Safe to re-run; run it with the core\'s API',
    'stopped, or run it again afterwards (a registration in flight can lose its row).',
    ''
  ].join('\n'));
}
