#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: release the platform rows left by registrations of the
// username "backloop".
//
// Before this release, registering "backloop" (public registration or
// system.createUser) answered success without creating the account, after the
// platform had already reserved the request's unique fields (email, ...) and
// the name->core row under that name. Those values could then never be used to
// register, and nothing released them. "backloop" is now a reserved username.
//
// What it does. Lists the PlatformDB rows owned by "backloop" (unique and
// indexed fields, name->core row) and, with --apply, deletes them. It prints
// counts per field and never the reserved values. It refuses to run when an
// account named "backloop" exists on this core.
//
// Usage:
//   node bin/platform-backloop-cleanup.js                  # report only (default)
//   node bin/platform-backloop-cleanup.js --apply          # delete the rows
//   node bin/platform-backloop-cleanup.js --config config/host-config.yml   # multi-core joiner
//
// PlatformDB is shared by all cores: run it on one core. Safe to re-run.

const path = require('path');

const USERNAME = 'backloop';

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
  appName: 'platform-backloop-cleanup',
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

    const storages = require('storages');
    await storages.init(config);
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();

    if (await usersRepository.usernameExists(USERNAME)) {
      console.error('platform-backloop-cleanup: an account named "' + USERNAME + '" exists on this core; nothing done.');
      process.exit(1);
    }

    const before = await listRows(storages.platformDB, platform);
    report(args.apply ? 'apply' : 'DRY-RUN (no writes)', before);

    if (args.apply && before.total > 0) {
      await platform.deleteUser(USERNAME, null);
      if (before.coreId != null) await platform.deleteUserCore(USERNAME);
      const after = await listRows(storages.platformDB, platform);
      console.log('  rows removed           ' + (before.total - after.total));
      if (after.total > 0) {
        console.log('  NOT REMOVED            ' + after.total + ' row(s); re-run, then check PlatformDB by hand');
        process.exit(1);
      }
    } else if (!args.apply && before.total > 0) {
      console.log('');
      console.log('  Re-run with --apply to release these rows.');
    }
    process.exit(0);
  } catch (err) {
    console.error('platform-backloop-cleanup: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

/** Rows owned by the username, in storage form (cleartext or hashed). */
async function listRows (platformDB, platform) {
  const owner = platform.hashFor('username', USERNAME);
  const entries = [
    ...await platformDB.getAllWithPrefix('user-unique/'),
    ...await platformDB.getAllWithPrefix('user-indexed/')
  ].filter((e) => e.username === owner);
  const uniqueByField = {};
  let indexed = 0;
  for (const e of entries) {
    if (e.isUnique) uniqueByField[e.field] = (uniqueByField[e.field] || 0) + 1;
    else indexed++;
  }
  const coreId = await platform.getUserCore(USERNAME);
  return { uniqueByField, indexed, coreId, total: entries.length + (coreId != null ? 1 : 0) };
}

function report (mode, rows) {
  console.log('platform-backloop-cleanup: ' + mode);
  const fields = Object.keys(rows.uniqueByField);
  const uniqueCount = fields.reduce((n, f) => n + rows.uniqueByField[f], 0);
  console.log('  unique values reserved ' + uniqueCount);
  for (const f of fields) console.log('    ' + f + ' ' + rows.uniqueByField[f]);
  console.log('  indexed fields         ' + rows.indexed);
  console.log('  name->core row         ' + (rows.coreId != null ? 'yes (' + rows.coreId + ')' : 'no'));
}

function parseArgs (argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--config') { i++; /* consumed by boiler at init */ } else {
      console.error('Unknown option: ' + a);
      process.exit(1);
    }
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) {
    console.error('--apply and --dry-run are exclusive');
    process.exit(1);
  }
  return args;
}

function printUsage (stream) {
  stream.write([
    'Release the platform rows (reserved emails and other unique values, name->core',
    'row) left by registrations of the username "backloop", which answered success',
    'without creating the account.',
    '',
    'Usage:',
    '  node bin/platform-backloop-cleanup.js            # report; do not write (default)',
    '  node bin/platform-backloop-cleanup.js --apply    # delete the rows',
    '',
    'On a multi-core joiner that layers a host-config file on top, pass it through:',
    '  node bin/platform-backloop-cleanup.js --config config/host-config.yml',
    '',
    'PlatformDB is shared by all cores: run it on one core. Safe to re-run.',
    ''
  ].join('\n'));
}
