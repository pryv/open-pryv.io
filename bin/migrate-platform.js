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
// Copies every platform record group through the PlatformDB interface:
// user unique/indexed fields, user-core map, core infos, DNS records,
// ACME account, TLS certificates, observability values, mail templates,
// invitation tokens. Access-request states are ephemeral (TTL-bounded
// polling state) and are intentionally NOT migrated — run the migration
// with the master process stopped and they are irrelevant.
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

const ENGINES = ['rqlite', 'postgresql'];

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

async function migrate (source, target, { dryRun, force }) {
  const verb = dryRun ? 'would migrate' : 'migrating';

  // Refuse to write into a non-empty target unless forced — a stale
  // half-populated target silently winning over fresh source rows is the
  // failure mode to avoid.
  const targetUserRows = await target.exportAll();
  if (targetUserRows.length > 0 && !force && !dryRun) {
    throw new Error(
      `target already holds ${targetUserRows.length} user-field record(s) — ` +
      'wipe it or re-run with --force to overwrite record-by-record.'
    );
  }

  let total = 0;
  const report = (group, count) => {
    console.log(`${verb} ${String(count).padStart(5)}  ${group}`);
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

  const mailTemplates = await source.getAllMailTemplates();
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

  console.log(`${dryRun ? 'DRY RUN — ' : ''}${total} record(s) ${dryRun ? 'would be migrated' : 'migrated'}.`);
  if (!dryRun) {
    console.log('Done. Flip `storages.platform.engine` in your config and restart the master process.');
  }
}

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
    'templates, invitation tokens) from one platform engine to the other.\n' +
    'Access-request states (ephemeral) are not migrated.\n' +
    '\n' +
    'Stop the master process first; keep the source engine\'s backing store\n' +
    'reachable (rqlited / PostgreSQL). Run before flipping\n' +
    '`storages.platform.engine`, then flip + restart.\n' +
    '\n' +
    '  --dry-run   count records per group, write nothing\n' +
    '  --force     overwrite records in a non-empty target\n'
  );
}
