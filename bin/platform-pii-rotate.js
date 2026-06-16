#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Rotate the platform.piiHmacKey on a single core.
//
// Background: PlatformDB rows in `platform.piiMode: hashed` deployments key
// off HMAC-SHA-256(pepper, field || NUL || value). Rotating the pepper
// changes every HMAC, so existing rows must be re-derived from cleartext
// + rewritten under the new HMAC. The cleartext is NOT in PlatformDB —
// it's on each home core's per-user account storage (system-stream
// events). The tool therefore walks the local usersRepository and
// rebuilds the rows for users this core hosts.
//
// Multi-core rotation: run this script on EVERY core in turn after
// distributing the new pepper. Each core handles only the rows that
// reference its own users. Run sequence:
//   1. Distribute the new pepper to every core (bundle reissue or
//      operator-sync of override-config.yml).
//   2. Set platform.piiHmacKey to the new value on every core but do NOT
//      restart yet — the tool needs to read the old rows.
//   3. Run `node bin/platform-pii-rotate.js up --old-pepper <BASE64>`
//      on each core. The --old-pepper is the OUTGOING pepper; the new
//      one is read from config.
//   4. After every core has finished, restart the cluster so the
//      api-server picks up the new pepper as its primary.
//
// DNS records: this tool does NOT rotate dns-record/* rows. The
// cleartext subdomain is not recoverable from PlatformDB alone and is
// not in user-account storage. Operators must delete + recreate any
// runtime DNS records (e.g. ACME challenges) after rotation. Config-
// static DNS entries are unaffected — they re-hash automatically on
// next boot from their plaintext config keys.
//
// Usage:
//   node bin/platform-pii-rotate.js status --old-pepper <BASE64>
//   node bin/platform-pii-rotate.js up     --old-pepper <BASE64>
//   node bin/platform-pii-rotate.js up     --old-pepper <BASE64> --dry-run

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'platform-pii-rotate',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../config/plugins/systemStreams')
  }, {
    plugin: require('../config/plugins/core-identity')
  }]
});

const USERNAME_FIELD = 'username';

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command == null || args.oldPepper == null) {
      printUsage(process.stderr);
      process.exit(1);
    }
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const piiMode = config.get('platform:piiMode') || 'cleartext';
    if (piiMode !== 'hashed') {
      console.error('platform-pii-rotate: refusing to run when platform.piiMode is "' + piiMode + '" — pepper rotation only applies to hashed-mode deployments.');
      process.exit(2);
    }
    const newPepper = config.get('platform:piiHmacKey');
    if (typeof newPepper !== 'string' || newPepper === '' || newPepper === 'REPLACE ME') {
      console.error('platform-pii-rotate: platform.piiHmacKey (new pepper) is unset or still the placeholder.');
      process.exit(2);
    }
    if (newPepper === args.oldPepper) {
      console.error('platform-pii-rotate: --old-pepper is identical to platform.piiHmacKey — nothing to rotate.');
      process.exit(2);
    }
    const { PiiHasher } = require('platform/src/PiiHasher.ts');
    const oldHasher = new PiiHasher(args.oldPepper);
    const newHasher = new PiiHasher(newPepper);

    await require('storages').init(config);
    const platformDB = require('storages').platformDB;

    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    const accountStreams = require('business/src/system-streams/index.ts');
    const indexedFields = accountStreams.indexedFieldNames;
    const uniqueFields = accountStreams.uniqueFieldNames;
    const thisCoreId = config.get('core:id') || 'single';
    const isSingleCore = config.get('core:isSingleCore') !== false;

    const allUsers = await usersRepository.getAll();
    const ownedHere = isSingleCore
      ? allUsers
      : await filterUsersOwnedByCore(platformDB, allUsers, thisCoreId, oldHasher);

    console.log('platform-pii-rotate: scope');
    console.log('  this core: ' + thisCoreId + ' (' + (isSingleCore ? 'single-core' : 'multi-core') + ')');
    console.log('  users on this core: ' + ownedHere.length + ' (of ' + allUsers.length + ' total in repository)');

    if (args.command === 'status') {
      console.log('platform-pii-rotate: would rehash ' + ownedHere.length + ' user(s) with the new pepper.');
      console.log('platform-pii-rotate: dns-record/* rows are NOT rotated — re-add runtime DNS entries after the cluster restart.');
      process.exit(0);
    }
    if (args.command !== 'up') {
      printUsage(process.stderr);
      process.exit(1);
    }
    if (args.dryRun) {
      console.log('--dry-run: not writing.');
      process.exit(0);
    }

    let userCoreCount = 0;
    let uniqueCount = 0;
    let indexedCount = 0;
    for (const user of ownedHere) {
      const oldUserToken = oldHasher.hashFor(USERNAME_FIELD, user.username);
      const newUserToken = newHasher.hashFor(USERNAME_FIELD, user.username);

      // user-core/* — replace the home-core mapping if the user is on
      // this core. (For users not on this core, the mapping was filtered
      // out above; in single-core mode every mapping lands here.)
      if (oldUserToken !== newUserToken) {
        await platformDB.setUserCore(newUserToken, thisCoreId);
        await platformDB.deleteUserCore(oldUserToken);
        userCoreCount++;
      }

      // unique fields (email + any operator-added isUnique field)
      for (const field of uniqueFields) {
        if (field === 'username') continue;
        const value = user[field];
        if (value == null) continue;
        const oldValueToken = oldHasher.hashFor(field, String(value));
        const newValueToken = newHasher.hashFor(field, String(value));
        if (oldValueToken === newValueToken && oldUserToken === newUserToken) continue;
        await platformDB.setUserUniqueField(newUserToken, field, newValueToken);
        await platformDB.deleteUserUniqueField(field, oldValueToken);
        uniqueCount++;
      }

      // indexed (non-unique) fields — username key changes, value stays cleartext
      for (const field of indexedFields) {
        if (uniqueFields.includes(field)) continue; // already handled above
        const value = user[field];
        if (value == null) continue;
        if (oldUserToken === newUserToken) continue; // pepper-only-mode-changes scenario
        await platformDB.setUserIndexedField(newUserToken, field, String(value));
        await platformDB.deleteUserIndexedField(oldUserToken, field);
        indexedCount++;
      }
    }

    console.log('platform-pii-rotate: done.');
    console.log('  user-core rows rotated:    ' + userCoreCount);
    console.log('  user-unique rows rotated:  ' + uniqueCount);
    console.log('  user-indexed rows rotated: ' + indexedCount);
    console.log('  dns-record rows: untouched (re-add runtime DNS entries manually).');
    process.exit(0);
  } catch (err) {
    console.error('platform-pii-rotate: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

/** Multi-core only: keep users whose user-core row (under the OLD pepper)
 *  maps to this core. Filters out users that another core owns. */
async function filterUsersOwnedByCore (platformDB, users, thisCoreId, oldHasher) {
  const kept = [];
  for (const user of users) {
    const token = oldHasher.hashFor(USERNAME_FIELD, user.username);
    const homeCore = await platformDB.getUserCore(token);
    if (homeCore === thisCoreId) kept.push(user);
  }
  return kept;
}

function parseArgs (argv) {
  const args = { command: null, oldPepper: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--old-pepper') {
      args.oldPepper = argv[++i] || null;
    } else if (a.startsWith('--')) {
      console.error('Unknown option: ' + a);
      process.exit(1);
    } else if (args.command == null) {
      args.command = a;
    }
  }
  return args;
}

function printUsage (stream) {
  stream.write([
    'Usage:',
    '  node bin/platform-pii-rotate.js status --old-pepper <BASE64>',
    '  node bin/platform-pii-rotate.js up     --old-pepper <BASE64>',
    '  node bin/platform-pii-rotate.js up     --old-pepper <BASE64> --dry-run',
    '',
    'Prerequisites:',
    '  - platform.piiMode: hashed',
    '  - platform.piiHmacKey already updated to the NEW pepper in config',
    '  - --old-pepper supplied via CLI (the outgoing pepper, base64 32 bytes)',
    '  - Cluster offline or writers paused; backup taken (bin/backup.js)',
    '',
    'Multi-core: run this on EVERY core in turn. Each core rotates the',
    'rows that reference users it hosts. After every core finishes,',
    'restart the cluster.',
    '',
    'DNS records: not rotated by this tool. Re-add runtime DNS entries',
    '(ACME challenges, admin-added subdomains) after the cluster restart.',
    ''
  ].join('\n'));
}
