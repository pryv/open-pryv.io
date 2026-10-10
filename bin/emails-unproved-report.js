#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool, read-only: list the email addresses accounts hold without
// having proved them.
//
// For every account on this core it reads the emails container and reports the
// entries whose ownership was never proved: `pending` ones, and `verified` ones
// asserted at registration or by the legacy email field. An account with no
// container reports its legacy email as an asserted registration address. It
// also cross-checks the platform `email` uniqueness rows owned by each account:
// a row held by an unproved entry, and a row matching no entry at all (orphan).
//
// By default it prints counts and usernames only; `--values` adds the
// addresses (and, for orphan rows, the stored row value, which is an HMAC token
// when PII hashing is on). It writes nothing.
//
// Usage:
//   node bin/emails-unproved-report.js
//   node bin/emails-unproved-report.js --values
//   node bin/emails-unproved-report.js --config config/host-config.yml
//
// Containers are per-core: run it on every core.

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
  appName: 'emails-unproved-report',
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
    const container = require('business/src/emails/container.ts');
    const C = require('business/src/emails/constants.ts');

    // Email rows grouped by owner, in storage form (cleartext or HMAC tokens).
    const rowsByOwner = new Map();
    for (const e of await storages.platformDB.getAllWithPrefix('user-unique/')) {
      if (e.field !== C.UNIQUE_FIELD) continue;
      if (!rowsByOwner.has(e.username)) rowsByOwner.set(e.username, []);
      rowsByOwner.get(e.username).push(String(e.value));
    }

    const totals = { accounts: 0, withUnproved: 0, unproved: 0, rowsHeldUnproved: 0, orphanRows: 0 };
    for (const { id, username } of await usersRepository.getAllUsersIdAndName()) {
      totals.accounts++;
      let entries = (await container.getRawEvents(id)).map((ev) => ({
        value: ev.content.value,
        status: ev.content.status,
        method: ev.content.verificationMethod ?? null,
        created: ev.created ?? null,
        tokenExpires: ev.content.verificationTokenExpires ?? null,
        proved: C.isProvedOwnership(ev.content)
      }));
      if (entries.length === 0) {
        const legacy = await usersRepository.getOnePropertyValue(id, 'email');
        entries = legacy == null
          ? []
          : [{ value: legacy, status: C.STATUS_VERIFIED, method: C.METHOD_REGISTRATION, created: null, tokenExpires: null, proved: false }];
      }
      const rows = rowsByOwner.get(platform.hashFor('username', username)) || [];
      const tokenOf = (value) => platform.hashFor(C.UNIQUE_FIELD, value);
      const entryTokens = new Set(entries.map((e) => tokenOf(e.value)));
      const unproved = entries.filter((e) => !e.proved);
      const heldUnproved = unproved.filter((e) => rows.includes(tokenOf(e.value)));
      const orphans = rows.filter((r) => !entryTokens.has(r));
      if (unproved.length === 0 && orphans.length === 0) continue;

      if (unproved.length > 0) totals.withUnproved++;
      totals.unproved += unproved.length;
      totals.rowsHeldUnproved += heldUnproved.length;
      totals.orphanRows += orphans.length;
      console.log(`${username}: ${unproved.length} unproved, ${heldUnproved.length} holding a row, ${orphans.length} orphan row(s)`);
      if (!args.values) continue;
      for (const e of unproved) {
        const held = rows.includes(tokenOf(e.value)) ? 'row' : 'no-row';
        console.log(`  ${e.value}  status=${e.status} method=${e.method} created=${e.created} tokenExpires=${e.tokenExpires} ${held}`);
      }
      for (const r of orphans) console.log(`  orphan row ${r}`);
    }

    console.log('');
    console.log(`accounts scanned            ${totals.accounts}`);
    console.log(`accounts with unproved      ${totals.withUnproved}`);
    console.log(`unproved addresses          ${totals.unproved}`);
    console.log(`  of which holding a row    ${totals.rowsHeldUnproved}`);
    console.log(`orphan email rows           ${totals.orphanRows}`);
    process.exit(0);
  } catch (err) {
    console.error('emails-unproved-report: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function parseArgs (argv) {
  const args = { values: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--values') args.values = true;
    else if (a === '--config') { i++; /* consumed by boiler at init */ } else {
      console.error('Unknown option: ' + a);
      process.exit(1);
    }
  }
  return args;
}

function printUsage (stream) {
  stream.write([
    'List, read-only, the email addresses accounts on this core hold without having',
    'proved them (pending, or asserted at registration / by the legacy email field),',
    'and the platform email rows they hold or that match no address (orphans).',
    '',
    'Usage:',
    '  node bin/emails-unproved-report.js            # counts and usernames',
    '  node bin/emails-unproved-report.js --values   # also print the addresses',
    '',
    'On a multi-core joiner that layers a host-config file on top, pass it through:',
    '  node bin/emails-unproved-report.js --config config/host-config.yml',
    '',
    'Containers are per-core: run it on every core. Writes nothing.',
    ''
  ].join('\n'));
}
