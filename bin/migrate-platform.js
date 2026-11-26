#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// One-shot platform-data migration between platform storage engines.
//
// Typical uses:
//   - Adopt the single-core diskless shape:  rqlite -> postgresql
//   - Go multi-core from a diskless deploy:  postgresql -> rqlite
//
// Copies every platform row through the PlatformDB interface: user
// unique/indexed fields, user-core map, core infos, DNS records, ACME
// account, TLS certificates, observability values, mail templates and
// invitation tokens through their typed methods; then every other row as
// stored (OAuth clients and grants, revocation lists, erasure ledger,
// access index, external-id namespaces and holds, TTL state, windowed
// counters, and any family added later).
//
// Requirements:
//   - Stop the master process first (no concurrent platform writes).
//   - The SOURCE engine's backing store must be reachable: keep (or
//     start) rqlited when migrating from rqlite; PostgreSQL must be up
//     when migrating from postgresql.
//   - Run BEFORE flipping `storages.platform.engine` in the config;
//     flip + restart after the migration reports OK.
//
// Usage:
//   node bin/migrate-platform.js --from rqlite --to postgresql [--dry-run] [--force]
//   node bin/migrate-platform.js --from postgresql --to rqlite [--dry-run] [--force]

const path = require('path');

const ENGINES = ['rqlite', 'postgresql'];

function main () {
  if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
    printUsage(process.stdout);
    process.exit(0);
  }

  require('@pryv/boiler').init({
    appName: 'migrate-platform',
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

  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      if (!ENGINES.includes(args.from) || !ENGINES.includes(args.to) || args.from === args.to) {
        printUsage(process.stderr);
        process.exit(1);
      }

      const { getConfig } = require('@pryv/boiler');
      const config = await getConfig();

      const source = await buildPlatformDB(args.from, config);
      const target = await buildPlatformDB(args.to, config);

      await migrate(source, target, args);
      process.exit(0);
    } catch (err) {
      console.error('migrate-platform failed: ' + (err && err.message ? err.message : err));
      process.exit(1);
    }
  })();
}

async function buildPlatformDB (engine, config) {
  if (engine === 'rqlite') {
    const { DBrqlite } = require('../storages/engines/rqlite/src/DBrqlite.ts');
    const url = config.get('storages:engines:rqlite:url') || undefined;
    const db = new DBrqlite(url);
    await db.init();
    return db;
  }
  // postgresql
  const { _internals } = require('../storages/engines/postgresql/src/_internals.ts');
  if (!_internals.databasePG) {
    const { getLogger } = require('@pryv/boiler');
    const pgConfig = config.get('storages:engines:postgresql');
    _internals.set('getLogger', getLogger);
    _internals.set('config', pgConfig);
    const { DatabasePG } = require('../storages/engines/postgresql/src/DatabasePG.ts');
    _internals.set('databasePG', new DatabasePG(pgConfig));
  }
  const { DBpostgresql } = require('../storages/engines/postgresql/src/DBpostgresql.ts');
  const db = new DBpostgresql();
  await db.init();
  return db;
}

async function migrate (source, target, { dryRun, force, log = console.log }) {
  const verb = dryRun ? 'would migrate' : 'migrating';

  // Refuse to write into a non-empty target unless forced: rows of any family
  // already there (a stale half-populated target, an engine in use) would be
  // mixed with or overwritten by the source rows. The rows an engine writes
  // for itself do not count. The message gives counts per family only (a
  // key may carry a token).
  if (!force && !dryRun) {
    const held = new Map();
    for (const { key } of await target.listAllPlatformKvEntries()) {
      if (ENGINE_OWNED_KEYS.includes(key)) continue;
      const family = familyOf(key);
      held.set(family, (held.get(family) || 0) + 1);
    }
    if (held.size > 0) {
      const count = [...held.values()].reduce((a, b) => a + b, 0);
      const families = [...held.keys()].sort().map((f) => `${f} ${held.get(f)}`).join(', ');
      throw new Error(
        `target already holds ${count} platform row(s) (${families}); ` +
        'wipe it or re-run with --force to overwrite record-by-record.'
      );
    }
  }

  let total = 0;
  const report = (group, count) => {
    log(`${verb} ${String(count).padStart(5)}  ${group}`);
    total += count;
  };

  const userFields = await source.exportAll();
  if (!dryRun) await target.importAll(userFields);
  report('user unique/indexed fields', userFields.length);

  const userCores = await source.getAllUserCores();
  if (!dryRun) for (const { username, coreId } of userCores) await target.setUserCore(username, coreId);
  report('user-core mappings', userCores.length);

  const coreInfos = await source.getAllCoreInfos();
  if (!dryRun) for (const info of coreInfos) await target.setCoreInfo(info.id, info);
  report('core infos', coreInfos.length);

  const dnsRecords = await source.getAllDnsRecords();
  if (!dryRun) for (const { subdomain, records } of dnsRecords) await target.setDnsRecord(subdomain, records);
  report('DNS records', dnsRecords.length);

  const acmeAccount = await source.getAcmeAccount();
  if (acmeAccount != null && !dryRun) await target.setAcmeAccount(acmeAccount);
  report('ACME account', acmeAccount != null ? 1 : 0);

  const certSummaries = await source.listCertificates();
  if (!dryRun) {
    for (const { hostname } of certSummaries) {
      const cert = await source.getCertificate(hostname);
      if (cert != null) await target.setCertificate(hostname, cert);
    }
  }
  report('TLS certificates', certSummaries.length);

  const observability = await source.getAllObservabilityValues();
  if (!dryRun) for (const { key, value } of observability) await target.setObservabilityValue(key, value);
  report('observability values', observability.length);

  // Templates outside the allowed Pug subset are not copied (they are never
  // used for sending either).
  const { validateMailTemplate, describe } = require('../components/mail/src/templateValidator.ts');
  const mailTemplates = [];
  for (const row of await source.getAllMailTemplates()) {
    const { ok, problems } = validateMailTemplate(row);
    if (ok) mailTemplates.push(row);
    else log(`skipping mail template ${describe(row)}: ${problems.join('; ')}`);
  }
  if (!dryRun) for (const { type, lang, part, pug } of mailTemplates) await target.setMailTemplate(type, lang, part, pug);
  report('mail templates', mailTemplates.length);

  const invitations = await source.getAllInvitationTokens();
  if (!dryRun) {
    for (const entry of invitations) {
      const { id, ...info } = entry;
      await target.createInvitationToken(id, info);
    }
  }
  report('invitation tokens', invitations.length);

  // Every other row, copied as stored (key and value unchanged), whatever
  // family it belongs to: OAuth clients and revocation lists, the erasure
  // ledger, the access index, external-id namespaces and holds (the
  // `claimCoreRow` families live in the same table), and any family added
  // later. Listing the whole table instead of known prefixes is what keeps a
  // new family from being left behind.
  // TTL state (`access-state/`) is copied too, expired rows included: it holds
  // durable grants (OAuth refresh tokens), single-use and replay markers that
  // must stay spent, and expired OAuth codes the orphan sweep still reads to
  // revoke the access minted for them. Windowed counters (`counter/`) are
  // copied so a send budget is not reset by the switch. The target's own
  // sweeps remove what has expired.
  const generic = new Map();
  for (const row of await source.listAllPlatformKvEntries()) {
    if (isTypedFamily(row.key) || ENGINE_OWNED_KEYS.includes(row.key)) continue;
    const family = familyOf(row.key);
    if (!generic.has(family)) generic.set(family, []);
    generic.get(family).push(row);
  }
  for (const family of [...generic.keys()].sort()) {
    const rows = generic.get(family);
    if (!dryRun) for (const { key, value } of rows) await target.setPlatformKv(key, value);
    report('platform rows ' + family, rows.length);
  }

  log(`${dryRun ? 'DRY RUN: ' : ''}${total} record(s) ${dryRun ? 'would be migrated' : 'migrated'}.`);
  if (!dryRun) {
    log('Done. Flip `storages.platform.engine` in your config and restart the master process.');
  }
}

// Families copied above through their typed methods (mail templates are
// filtered there, so they must not be copied again as raw rows).
const TYPED_PREFIXES = ['user-unique/', 'user-indexed/', 'user-core/', 'core-info/', 'dns-record/',
  'tls-cert/', 'observability/', 'mail-template/', 'invitation/'];
const TYPED_KEYS = ['tls-acme-account'];

// Rows an engine writes for itself, never copied nor counted: the rqlite
// engine's schema-migration marker (each engine tracks its own schema; the
// PostgreSQL one keeps it in a table of its own, outside platform_kv).
const ENGINE_OWNED_KEYS = ['migrations/version'];

function isTypedFamily (key) {
  return TYPED_KEYS.includes(key) || TYPED_PREFIXES.some((p) => key.startsWith(p));
}

// The report groups rows by their first key segment; keys without one are
// counted together (a key is never printed, it may carry a token), except
// the fixed typed keys, which are names.
function familyOf (key) {
  if (TYPED_KEYS.includes(key)) return key;
  const slash = key.indexOf('/');
  return slash > 0 ? key.slice(0, slash + 1) : '(other keys)';
}

module.exports = { migrate };

// Run as a command; required (tests), it only exports `migrate`.
if (require.main === module) main();

function parseArgs (argv) {
  const out = { from: null, to: null, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
  }
  return out;
}

function printUsage (stream) {
  stream.write(
    'Usage: node bin/migrate-platform.js --from <engine> --to <engine> [--dry-run] [--force]\n' +
    '\n' +
    'Engines: rqlite | postgresql\n' +
    '\n' +
    'Copies all platform data (user fields, user-core map, core infos, DNS\n' +
    'records, ACME account, TLS certificates, observability values, mail\n' +
    'templates, invitation tokens, and every other platform row as stored:\n' +
    'OAuth clients and grants, erasure ledger, access index, external ids,\n' +
    'TTL state, counters) from one platform engine to the other.\n' +
    '\n' +
    'Stop the master process first; keep the source engine\'s backing store\n' +
    'reachable (rqlited / PostgreSQL). Run before flipping\n' +
    '`storages.platform.engine`, then flip + restart.\n' +
    '\n' +
    '  --dry-run   count records per group, write nothing\n' +
    '  --force     overwrite records in a non-empty target\n'
  );
}
