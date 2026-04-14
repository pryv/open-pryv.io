#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// CLI for managing persistent DNS records directly in PlatformDB (rqlite).
// Works whether the master process is running or not — the running DnsServer
// picks up changes on its next periodic refresh (default 30 s).
//
// Usage:
//   node bin/dns-records.js list
//   node bin/dns-records.js load records.yaml [--dry-run] [--replace]
//   node bin/dns-records.js delete <subdomain>
//   node bin/dns-records.js export [file]
//
// YAML file format:
//   records:
//     - subdomain: _acme-challenge
//       records:
//         txt: ["validation-token"]
//     - subdomain: www
//       records:
//         a: ["1.2.3.4"]

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

// Handle --help before boiler init (boiler's yargs swallows --help otherwise).
if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'dns-records',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    plugin: require('../config/plugins/systemStreams')
  }, {
    plugin: require('../config/plugins/core-identity')
  }]
});

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command == null) {
      printUsage(process.stderr);
      process.exit(1);
    }

    const platform = await initPlatform();

    switch (args.command) {
      case 'list':
        await runList(platform);
        break;
      case 'load':
        await runLoad(platform, args);
        break;
      case 'delete':
        await runDelete(platform, args);
        break;
      case 'export':
        await runExport(platform, args);
        break;
      default:
        console.error('Unknown command: ' + args.command);
        printUsage(process.stderr);
        process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function initPlatform () {
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();
  await require('storages').init(config);
  const { getPlatform } = require('platform');
  return await getPlatform();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runList (platform) {
  const rows = await platform.getAllDnsRecords();
  if (rows.length === 0) {
    console.log('(no persistent DNS records)');
    return;
  }
  const doc = { records: rows.map(({ subdomain, records }) => ({ subdomain, records })) };
  process.stdout.write(yaml.dump(doc, { lineWidth: 200 }));
}

async function runLoad (platform, args) {
  if (!args.file) throw new Error('load: file argument is required');
  if (!fs.existsSync(args.file)) throw new Error('File not found: ' + args.file);

  const raw = fs.readFileSync(args.file, 'utf8');
  const doc = yaml.load(raw);
  if (!doc || !Array.isArray(doc.records)) {
    throw new Error("File must contain a top-level 'records:' list");
  }

  const incoming = new Map();
  for (const [i, entry] of doc.records.entries()) {
    if (!entry || typeof entry.subdomain !== 'string') {
      throw new Error(`records[${i}]: 'subdomain' is required and must be a string`);
    }
    if (!entry.records || typeof entry.records !== 'object') {
      throw new Error(`records[${i}]: 'records' is required and must be an object`);
    }
    incoming.set(entry.subdomain, entry.records);
  }

  const existing = await platform.getAllDnsRecords();
  const existingBySubdomain = new Map(existing.map(r => [r.subdomain, r.records]));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  const plan = [];

  if (args.replace) {
    for (const { subdomain } of existing) {
      if (!incoming.has(subdomain)) {
        plan.push(['delete', subdomain, null]);
        removed++;
      }
    }
  }

  for (const [subdomain, records] of incoming) {
    const prev = existingBySubdomain.get(subdomain);
    if (prev == null) {
      plan.push(['put', subdomain, records]);
      added++;
    } else if (JSON.stringify(prev) === JSON.stringify(records)) {
      unchanged++;
    } else {
      plan.push(['put', subdomain, records]);
      updated++;
    }
  }

  console.log(`Plan: +${added} added, ~${updated} updated, =${unchanged} unchanged, -${removed} removed`);

  if (args.dryRun) {
    for (const [op, subdomain] of plan) {
      console.log(`  ${op === 'put' ? 'PUT   ' : 'DELETE'} ${subdomain}`);
    }
    console.log('(dry-run: no changes written)');
    return;
  }

  for (const [op, subdomain, records] of plan) {
    if (op === 'put') {
      await platform.setDnsRecord(subdomain, records);
    } else {
      await platform.deleteDnsRecord(subdomain);
    }
  }
  console.log('Done.');
}

async function runDelete (platform, args) {
  if (!args.subdomain) throw new Error('delete: subdomain argument is required');
  const existing = await platform.getDnsRecord(args.subdomain);
  if (existing == null) {
    console.error(`No record for subdomain '${args.subdomain}'`);
    process.exit(2);
  }
  await platform.deleteDnsRecord(args.subdomain);
  console.log(`Deleted '${args.subdomain}'.`);
}

async function runExport (platform, args) {
  const rows = await platform.getAllDnsRecords();
  const doc = { records: rows.map(({ subdomain, records }) => ({ subdomain, records })) };
  const out = yaml.dump(doc, { lineWidth: 200 });
  if (args.file) {
    fs.writeFileSync(args.file, out, 'utf8');
    console.log(`Exported ${rows.length} record(s) to ${args.file}`);
  } else {
    process.stdout.write(out);
  }
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const out = { command: null, dryRun: false, replace: false, help: false };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--replace') out.replace = true;
    else positional.push(a);
  }

  out.command = positional[0] || null;
  switch (out.command) {
    case 'load':
    case 'export':
      out.file = positional[1] || null;
      break;
    case 'delete':
      out.subdomain = positional[1] || null;
      break;
  }
  return out;
}

function printUsage (stream = process.stderr) {
  stream.write(
`Usage:
  node bin/dns-records.js list
  node bin/dns-records.js load <file> [--dry-run] [--replace]
  node bin/dns-records.js delete <subdomain>
  node bin/dns-records.js export [file]

Flags:
  --dry-run   (load) show what would change, don't write
  --replace   (load) delete persisted records not present in the file
  -h, --help  print this help

YAML file format:
  records:
    - subdomain: _acme-challenge
      records:
        txt: ["token"]
    - subdomain: www
      records:
        a: ["1.2.3.4"]
`);
}
