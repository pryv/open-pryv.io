#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Standalone CLI for schema migrations. Opens the storages barrel directly —
// no HTTP dependency, works with or without master.js running.
//
// Usage:
//   node bin/migrate.js status
//   node bin/migrate.js up
//   node bin/migrate.js up --dry-run
//   node bin/migrate.js up --target 3
//
// See storages/interfaces/migrations/README.md for the model (timestamp
// filenames, integer version counter +1 per migration, forward-only).

const path = require('path');
const yaml = require('js-yaml');

if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'migrate',
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

    const { getConfig, getLogger } = require('@pryv/boiler');
    const config = await getConfig();
    await require('storages').init(config);
    const { createMigrationRunner } = require('storages/interfaces/migrations');
    const runner = await createMigrationRunner({ logger: getLogger('migrate') });

    switch (args.command) {
      case 'status':
        await runStatus(runner);
        break;
      case 'up':
        await runUp(runner, args);
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
// Commands
// ---------------------------------------------------------------------------

async function runStatus (runner) {
  const st = await runner.status();
  const out = {
    engines: st.map(s => ({
      id: s.engineId,
      version: s.currentVersion,
      pending: s.pending.map(p => ({ filename: p.filename, targetVersion: p.targetVersion }))
    }))
  };
  process.stdout.write(yaml.dump(out, { lineWidth: 200 }));
}

async function runUp (runner, args) {
  const opts = {};
  if (args.target != null) opts.targetVersion = args.target;
  if (args.dryRun) opts.dryRun = true;

  const applied = await runner.runAll(opts);
  if (applied.length === 0) {
    console.log('No pending migrations.');
    return;
  }
  const prefix = args.dryRun ? '[dry-run]' : '';
  for (const a of applied) {
    console.log(`${prefix} ${a.engineId}: ${a.filename}  ${a.fromVersion} → ${a.toVersion}${args.dryRun ? '' : `  (${a.durationMs}ms)`}`);
  }
  console.log(`${args.dryRun ? 'Would apply' : 'Applied'} ${applied.length} migration(s).`);
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const out = { command: null, dryRun: false, target: null };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--target') {
      const next = argv[++i];
      if (next == null || !/^\d+$/.test(next)) {
        throw new Error('--target requires a positive integer');
      }
      out.target = parseInt(next, 10);
    } else if (!a.startsWith('--')) {
      positional.push(a);
    } else {
      throw new Error('Unknown flag: ' + a);
    }
  }

  out.command = positional[0] || null;
  return out;
}

function printUsage (stream = process.stderr) {
  stream.write(
`Usage:
  node bin/migrate.js status
  node bin/migrate.js up [--target N] [--dry-run]

Commands:
  status    Print per-engine current version and pending migrations (YAML)
  up        Apply pending migrations across all engines

Flags:
  --target N   (up) stop per-engine when version reaches N
  --dry-run    (up) compute plan without executing
  -h, --help   print this help

See storages/interfaces/migrations/README.md for conventions.
`);
}
