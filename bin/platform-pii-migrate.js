#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// One-shot operator tool: rehash existing PlatformDB rows from cleartext PII
// to HMAC tokens, so that subsequent runs in `platform.piiMode: hashed` find
// the same rows. Operator runs this once per cluster when switching modes.
//
// Pre-flight expectations:
//   - Operator config has `platform.piiMode: hashed` already set + a usable
//     `platform.piiHmacKey` distributed to every core. The script reads the
//     pepper from the config it boots against.
//   - The cluster is OFFLINE (or at least all writers are paused). Live
//     traffic during migration would write half-cleartext-half-hashed rows.
//   - A backup exists (`bin/backup.js` includes PlatformDB).
//
// Behaviour:
//   - Reads every cleartext row in PlatformDB by enumerating the engine's
//     prefix scans (`user-core/`, `user-unique/`, `user-indexed/`).
//   - For each row, computes the hashed equivalent (key + value, where the
//     value is itself a username on `user-unique/*` rows). Writes the
//     hashed row, then deletes the cleartext row. Atomic enough at the
//     row granularity that a crash mid-loop leaves a half-migrated state
//     that the next run finishes.
//   - Skips rows whose key already looks HMAC-shaped (64 lowercase hex
//     chars). Hence the script is idempotent + restartable.
//   - Touches only `user-*` keys (user-core / user-unique / user-indexed).
//     DNS-record subdomains are operator infrastructure names, NOT user
//     PII, so they are stored cleartext and left untouched. Other
//     PlatformDB namespaces (`core-info/`, `invitation/`, `tls-cert/`,
//     `acme-account`, `observability/*`, `mail-template/*`,
//     `access-state/*`, `platform-secrets/*`) likewise stay untouched.
//
// Usage:
//   node bin/platform-pii-migrate.js status    # report what would change
//   node bin/platform-pii-migrate.js up         # apply
//   node bin/platform-pii-migrate.js up --dry-run

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'platform-pii-migrate',
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

const HEX_64 = /^[0-9a-f]{64}$/;
const USERNAME_FIELD = 'username';

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command == null) {
      printUsage(process.stderr);
      process.exit(1);
    }
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const pepper = config.get('platform:piiHmacKey');
    const piiMode = config.get('platform:piiMode') || 'cleartext';
    if (piiMode !== 'hashed') {
      console.error('platform-pii-migrate: refusing to run while platform.piiMode is "' + piiMode + '"; flip the config to "hashed" before invoking this tool so the cluster post-migration writes match this script\'s output.');
      process.exit(2);
    }
    if (typeof pepper !== 'string' || pepper === '' || pepper === 'REPLACE ME') {
      console.error('platform-pii-migrate: platform.piiHmacKey is unset or still the placeholder; cannot derive HMAC tokens.');
      process.exit(2);
    }
    const { PiiHasher } = require('platform/src/PiiHasher.ts');
    const hasher = new PiiHasher(pepper);

    await require('storages').init(config);
    const platformDB = require('storages').platformDB;

    const plan = await buildPlan({ platformDB });
    console.log('platform-pii-migrate: scan summary');
    console.log('  user-core/      ' + plan.userCore.length.toString().padStart(6) + ' cleartext  ' + plan.alreadyHashed.userCore.toString().padStart(6) + ' already-hashed');
    console.log('  user-unique/    ' + plan.userUnique.length.toString().padStart(6) + ' cleartext  ' + plan.alreadyHashed.userUnique.toString().padStart(6) + ' already-hashed');
    console.log('  user-indexed/   ' + plan.userIndexed.length.toString().padStart(6) + ' cleartext  ' + plan.alreadyHashed.userIndexed.toString().padStart(6) + ' already-hashed');

    if (args.command === 'status') {
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

    const counts = await applyPlan({ platformDB, hasher, plan });
    console.log('platform-pii-migrate: rehashed');
    console.log('  user-core/      ' + counts.userCore);
    console.log('  user-unique/    ' + counts.userUnique);
    console.log('  user-indexed/   ' + counts.userIndexed);
    process.exit(0);
  } catch (err) {
    console.error('platform-pii-migrate: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

/** Decide which rows need rehashing. Idempotent: rows whose key portion
 *  already looks like a 64-char lowercase hex digest are treated as
 *  already hashed and skipped. */
async function buildPlan ({ platformDB }) {
  const plan = {
    userCore: [],         // [{ username, coreId }]
    userUnique: [],       // [{ field, value, ownerUsername }]
    userIndexed: [],      // [{ username, field, value }]
    alreadyHashed: { userCore: 0, userUnique: 0, userIndexed: 0 }
  };

  // --- user-core ---
  const userCores = await platformDB.getAllUserCores();
  for (const { username, coreId } of userCores) {
    if (HEX_64.test(username)) { plan.alreadyHashed.userCore++; continue; }
    plan.userCore.push({ username, coreId });
  }

  // --- user-unique + user-indexed (engine merges both under getAllWithPrefix('user')) ---
  // getAllWithPrefix returns parsed entries with field + username + value + isUnique.
  // The cleartext-vs-hashed distinction is on the in-key portion: for
  // user-unique that's `value`, for user-indexed that's `username`.
  const userEntries = await platformDB.getAllWithPrefix('user-');
  for (const entry of userEntries) {
    if (entry.field == null) continue;
    if (entry.isUnique === true) {
      if (HEX_64.test(entry.value)) { plan.alreadyHashed.userUnique++; continue; }
      plan.userUnique.push({ field: entry.field, value: entry.value, ownerUsername: entry.username });
    } else if (entry.username != null) {
      if (HEX_64.test(entry.username)) { plan.alreadyHashed.userIndexed++; continue; }
      plan.userIndexed.push({ username: entry.username, field: entry.field, value: entry.value });
    }
  }

  // DNS-record subdomains are operator infrastructure names, not user PII —
  // stored cleartext in all modes, so they are intentionally NOT migrated.

  return plan;
}

/** Apply the plan: write hashed row, delete cleartext row. Row-level
 *  atomicity — a crash mid-loop leaves rows half-migrated which the next
 *  run completes. */
async function applyPlan ({ platformDB, hasher, plan }) {
  const counts = { userCore: 0, userUnique: 0, userIndexed: 0 };

  for (const { username, coreId } of plan.userCore) {
    const usernameToken = hasher.hashFor(USERNAME_FIELD, username);
    await platformDB.setUserCore(usernameToken, coreId);
    await platformDB.deleteUserCore(username);
    counts.userCore++;
  }

  for (const { field, value, ownerUsername } of plan.userUnique) {
    const valueToken = hasher.hashFor(field, value);
    const usernameToken = hasher.hashFor(USERNAME_FIELD, ownerUsername);
    await platformDB.setUserUniqueField(usernameToken, field, valueToken);
    // Only delete the cleartext row if its in-key value isn't ALSO the
    // hashed value (collision with HMAC of itself — astronomically unlikely
    // but the check is free).
    if (valueToken !== value) {
      await platformDB.deleteUserUniqueField(field, value);
    }
    counts.userUnique++;
  }

  for (const { username, field, value } of plan.userIndexed) {
    const usernameToken = hasher.hashFor(USERNAME_FIELD, username);
    await platformDB.setUserIndexedField(usernameToken, field, value);
    if (usernameToken !== username) {
      await platformDB.deleteUserIndexedField(username, field);
    }
    counts.userIndexed++;
  }

  return counts;
}

function parseArgs (argv) {
  const args = { command: null, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--')) {
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
    '  node bin/platform-pii-migrate.js status    # report counts; do not change anything',
    '  node bin/platform-pii-migrate.js up         # rehash cleartext PlatformDB rows',
    '  node bin/platform-pii-migrate.js up --dry-run',
    '',
    'Prerequisites:',
    '  - platform.piiMode: hashed in config',
    '  - platform.piiHmacKey: base64 of 32 random bytes (same value on every core)',
    '  - Cluster offline or writers paused',
    '  - Recent backup (bin/backup.js)',
    ''
  ].join('\n'));
}
