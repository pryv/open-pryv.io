#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: list the accesses an app access created that reach further
// than their creator. READ-ONLY: it never changes an access.
//
// What it targets. Before this release, an app access holding a broad grant
// with a narrower entry below it (e.g. `{A: read}, {A/B: none}`) could create
// a shared access `{A: read}` that did not carry the narrower entry, so the
// shared access could read `A/B`. New accesses now carry those entries;
// accesses created earlier keep their reach.
//
// What it reports. For each local user, each live access created by a
// non-personal access is checked against its creator's current permissions:
//   - "reaches a carve-out": a granted stream covers a stream where the
//     creator holds `none`, `create-only` or a lower level, and the access
//     does not carry that entry;
//   - "exceeds level": a granted stream is above the creator's level there
//     (for example after the creator was narrowed).
// Output: counts, then one line per access found (username, access id,
// creator id). Tokens are never printed.
//
// What to do with a finding is the account owner's or operator's decision:
// narrow the access with accesses.update (a personal token), or delete it.
//
// Usage:
//   node bin/access-scope-audit.js                      # all local users
//   node bin/access-scope-audit.js --user <username>    # one account only
//   node bin/access-scope-audit.js --config config/host-config.yml   # multi-core joiner
//
// Run once per core. Writes nothing; safe to re-run.

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
  appName: 'access-scope-audit',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../config/plugins/systemStreams')
  }, {
    scope: 'default-audit-path',
    file: path.resolve(__dirname, '../config/plugins/default-path.js')
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
    // As the API server does: with audit active the mall serves the audit
    // streams, which an access's permissions can name (`:_audit:...`), and
    // checking such an access reads them from the audit storage. This tool
    // writes no audit record.
    if (config.get('audit:active')) await require('audit').default.init();
    const { getUsersLocalIndex, getStorageLayer } = require('storage');
    const { fromCallback } = require('utils');
    const { auditAccessScope } = require('business/src/accesses/scopeAudit.ts');

    const usersIndex = await getUsersLocalIndex();
    const storageLayer = await getStorageLayer();

    const byUsername = await usersIndex.getAllByUsername(); // { username: userId }
    let usernames = Object.keys(byUsername);
    if (args.user != null) {
      if (byUsername[args.user] == null) {
        console.error('access-scope-audit: no such user on this core: ' + args.user);
        process.exit(1);
      }
      usernames = [args.user];
    }

    const counts = { users: usernames.length, usersConcerned: 0, checked: 0, carveOut: 0, exceedsLevel: 0, creatorGone: 0 };
    const lines = [];
    for (const username of usernames) {
      const userId = byUsername[username];
      const user = { id: userId, username };
      const live = await fromCallback((cb) => storageLayer.accesses.find(user, {}, null, cb));
      const deleted = await fromCallback((cb) => storageLayer.accesses.findDeletions(user, 0, null, cb));
      const res = await auditAccessScope(userId, live || [], deleted || []);
      counts.checked += res.checked;
      counts.creatorGone += res.creatorGone;
      if (res.findings.length > 0) counts.usersConcerned++;
      for (const f of res.findings) {
        if (f.reason === 'reaches-carve-out') {
          counts.carveOut++;
          lines.push('    ' + username + ' access ' + f.accessId + ' (' + f.type + ', created by ' + f.creatorId +
            '): reaches a carve-out (' + f.missingEntries + ' missing entr' + (f.missingEntries === 1 ? 'y' : 'ies') + ')');
        } else {
          counts.exceedsLevel++;
          lines.push('    ' + username + ' access ' + f.accessId + ' (' + f.type + ', created by ' + f.creatorId +
            '): exceeds its creator\'s level');
        }
      }
    }

    console.log('access-scope-audit: REPORT ONLY (no writes)');
    console.log('  users scanned               ' + counts.users);
    console.log('  accesses checked            ' + counts.checked);
    console.log('  reaching a carve-out        ' + counts.carveOut);
    console.log('  exceeding creator\'s level   ' + counts.exceedsLevel);
    console.log('  users concerned             ' + counts.usersConcerned);
    console.log('  creator not found (skipped) ' + counts.creatorGone);
    for (const line of lines) console.log(line);
    if (lines.length > 0) {
      console.log('');
      console.log('  The accesses listed above reach data their creator cannot. Narrow them');
      console.log('  (accesses.update with a personal token) or delete them; this tool changes nothing.');
    }
    process.exit(0);
  } catch (err) {
    console.error('access-scope-audit: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function parseArgs (argv) {
  const args = { user: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') { i++; args.user = argv[i]; } else if (a === '--config') { i++; /* consumed by boiler at init */ } else if (a === '--dry-run') {
      // accepted for symmetry with the other operator tools: this one never writes
    } else {
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
    'List the accesses an app access created that reach further than their creator',
    '(a stream the creator is kept out of, or a level above the creator\'s).',
    'Report only: nothing is written. Tokens are never printed.',
    '',
    'Usage:',
    '  node bin/access-scope-audit.js                      # all local users',
    '  node bin/access-scope-audit.js --user <username>    # one account only',
    '',
    'On a multi-core joiner that layers a host-config file on top, pass it through:',
    '  node bin/access-scope-audit.js --config config/host-config.yml',
    '',
    'Run once per core. Safe to re-run.',
    ''
  ].join('\n'));
}
