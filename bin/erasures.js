#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// The erasure ledger: the durable records of account erasures, kept in the
// platform database after the accounts are gone (see accountErasure.ledger in
// config/default-config.yml). Each record names its account by keyed hashes
// only: this tool never prints a username it was not given.
//
//   node bin/erasures.js --list [--since <ms | ISO date>] [--limit <n>]
//   node bin/erasures.js --check <userId | username>
//   node bin/erasures.js --replay            (dry run: counts only)
//   node bin/erasures.js --replay --apply    (erases them)
//
// --replay is for a core whose storage was restored from a snapshot or a
// database dump taken before some erasures (bin/backup.js --restore checks the
// ledger itself): it looks up every account of this core's users index in the
// ledger and erases again each one recorded as erased and not restored since.
// Run it on each core so restored; the erasure it runs is recorded with the
// trigger `ledger-replay`.

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

// Multi-core joiners carry their storage config in a host-config file, layered
// on top via `--config` as bin/master.js does.
const configFileArg = (() => {
  const i = process.argv.indexOf('--config');
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
})();
if (process.argv.includes('--config') &&
    (configFileArg == null || configFileArg.startsWith('-') ||
     !require('fs').existsSync(path.resolve(process.cwd(), configFileArg)))) {
  console.error(`--config: file not found: ${configFileArg ?? '(missing <file>)'}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));

require('@pryv/boiler').init({
  appName: 'erasures',
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
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    // --replay --apply erases accounts: the same initialisation as
    // bin/backup.js (the user directories, the storages, the audit).
    const erasing = args.replay && args.apply;
    if (erasing) await require('storage').userLocalDirectory.init();
    await require('storages').init(config);
    if (erasing && config.get('audit:active')) await require('audit').default.init();
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    const ledger = require('business/src/erasureLedger/index.ts');
    const { erasureLedgerConfig } = require('business/src/erasureLedger/config.ts');
    if (!erasureLedgerConfig(config).enabled) {
      console.log('Note: accountErasure.ledger.enabled is false: no new record is written (the records already there are read).');
    }

    if (args.list) process.exit(await runList(platform, ledger));
    if (args.check != null) process.exit(await runCheck(platform, ledger, ledger.ledgerKey(config)));
    if (args.replay) process.exit(await runReplay(config, platform, ledger, ledger.ledgerKey(config)));
  } catch (err) {
    console.error('Error: ' + (err?.message ?? String(err)));
    if (process.env.DEBUG) console.error(err?.stack);
    process.exit(1);
  }
})();

function describe (entry) {
  return `${new Date(entry.deletedAt).toISOString()}  trigger ${entry.trigger}  core ${entry.coreId ?? 'unknown'}  ` +
    `audit ${entry.auditMode}  id-hash ${entry.userIdHash.slice(0, 16)}...  key ${entry.keyId}` +
    (entry.restoredAt != null ? `  restored ${new Date(entry.restoredAt).toISOString()}` : '');
}

async function runList (platform, ledger) {
  let after = null;
  let count = 0;
  do {
    const page = await ledger.listErasureRecords(platform, { since: args.since, limit: ledger.MAX_LIST_LIMIT, after });
    for (const entry of page.erasures) {
      if (args.limit != null && count >= args.limit) return 0;
      console.log(describe(entry));
      count++;
    }
    after = page.next != null ? ledger.parseCursor(page.next) : null;
  } while (after != null);
  console.log(`${count} erasure record(s)` + (args.since > 0 ? ` since ${new Date(args.since).toISOString()}` : ''));
  return 0;
}

async function runCheck (platform, ledger, key) {
  const byId = await ledger.lookupErasureRecords(platform, key, { userId: args.check });
  const byName = await ledger.lookupErasureRecords(platform, key, { username: args.check });
  const seen = new Set();
  const entries = [...byId, ...byName].filter((e) => !seen.has(e.userIdHash) && seen.add(e.userIdHash));
  if (entries.length === 0) {
    console.log('Not in the erasure ledger (no erasure recorded under the current key for this user id or username).');
    return 0;
  }
  for (const e of entries) {
    console.log((byId.includes(e) ? 'user id' : 'username') + ': erased ' + describe(e));
  }
  return 0;
}

async function runReplay (config, platform, ledger, key) {
  const { getUsersLocalIndex, getStorageLayer } = require('storage');
  const usersIndex = await getUsersLocalIndex();
  const accounts = Object.entries(await usersIndex.getAllByUsername());
  const toErase = [];
  for (const [username, userId] of accounts) {
    const entry = await ledger.readErasureRecord(platform, key, userId);
    if (entry != null && ledger.erasedAfter(entry, null)) toErase.push({ id: userId, username });
  }
  console.log(`${accounts.length} account(s) on this core, ${toErase.length} recorded as erased in the ledger and not restored since.`);
  if (!args.apply) {
    if (toErase.length > 0) console.log('Dry run: nothing erased. Run again with --apply to erase them.');
    return 0;
  }
  const { Deletion } = require('business/src/auth/deletion.ts');
  const deletion = new Deletion(null, await getStorageLayer(), config);
  let erased = 0;
  let failed = 0;
  for (const account of toErase) {
    try {
      await deletion.eraseAccount(account, { teardown: true, trigger: 'ledger-replay' });
      erased++;
    } catch (err) {
      failed++;
      // The id only: the name of an erased account is not printed.
      console.error(`The erasure of account ${account.id} failed (${err?.message ?? String(err)}): ` +
        'its record of the erasure in progress stays, and a running core completes it (the account auto-deletion sweep).');
    }
  }
  console.log(`${erased} account(s) erased again, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}

function parseArgs (argv) {
  const out = { list: false, check: null, replay: false, apply: false, since: 0, limit: null };
  const fail = (message) => {
    console.error(message);
    printUsage(process.stderr);
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--replay') out.replay = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--check') {
      out.check = argv[++i];
      if (out.check == null || out.check === '' || out.check.startsWith('--')) fail('--check needs a user id or a username');
    } else if (a === '--since') {
      const v = argv[++i];
      const ms = /^[0-9]+$/.test(v ?? '') ? Number(v) : Date.parse(v ?? '');
      if (!Number.isFinite(ms) || ms < 0) fail('--since needs a time in milliseconds or an ISO date');
      out.since = ms;
    } else if (a === '--limit') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) fail('--limit needs a whole number >= 1');
      out.limit = v;
    } else if (a === '--config') {
      i++;
    } else {
      fail(`Unknown argument: ${a}`);
    }
  }
  const modes = [out.list, out.check != null, out.replay].filter(Boolean).length;
  if (modes !== 1) fail('Give exactly one of --list, --check or --replay');
  if (out.apply && !out.replay) fail('--apply goes with --replay');
  if ((out.since > 0 || out.limit != null) && !out.list) fail('--since and --limit go with --list');
  return out;
}

function printUsage (stream) {
  stream.write(`
Usage: node bin/erasures.js <mode> [options]

The erasure ledger: one durable record per erased account (keyed hashes of its
user id and username, when it was erased, what decided it, on which core).

Modes (exactly one):
  --list                    List the records, oldest erasure first
    --since <ms | ISO date> Only the erasures from then on
    --limit <n>             At most n records
  --check <userId|username> Whether an account of this id, or of this name
                            (any case), was erased, and when
  --replay                  Look up every account of this core in the ledger:
                            count those recorded as erased and not restored
                            since (after a restore of the storage itself from
                            a snapshot or a dump). Dry run: erases nothing
    --apply                 Erase them again (trigger ledger-replay)

Options:
  --config <file>           Host config layered on top (as bin/master.js)
  --help, -h                Show this help

Exit codes: 0 done, 1 a failure (an erasure of --replay --apply included),
2 wrong arguments.
`);
}
