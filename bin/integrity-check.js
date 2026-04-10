#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Standalone CLI for data integrity verification.
// Recomputes integrity hashes on events and accesses and reports mismatches.
//
// Usage:
//   node bin/integrity-check.js                    # check all users
//   node bin/integrity-check.js --user userId123   # check a single user
//   node bin/integrity-check.js --json             # output report as JSON

const path = require('path');

require('@pryv/boiler').init({
  appName: 'integrity-check',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    plugin: require('../config/plugins/systemStreams')
  }, {
    scope: 'default-audit-path',
    file: path.resolve(__dirname, '../config/plugins/default-path.js')
  }, {
    plugin: require('../config/plugins/core-identity')
  }]
});

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printUsage();
      process.exit(0);
    }

    // Initialize storage
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const userLocalDirectory = require('storage').userLocalDirectory;
    await userLocalDirectory.init();
    await require('storages').init(config);

    const IntegrityCheck = require('business/src/integrity/IntegrityCheck');
    const checker = new IntegrityCheck();
    await checker.init();

    const log = args.json ? () => {} : (msg) => console.log(msg);

    let reports;
    if (args.user) {
      log(`Checking integrity for user: ${args.user}`);
      const report = await checker.checkUser(args.user);
      reports = [report];
    } else {
      log('Checking integrity for all users...');
      reports = await checker.checkAllUsers((userId, report) => {
        const status = report.ok ? 'OK' : 'ERRORS';
        const details = `events=${report.events.checked} accesses=${report.accesses.checked}`;
        const errorCount = report.events.errors.length + report.accesses.errors.length;
        log(`  [${status}] ${report.username || userId} — ${details}${errorCount > 0 ? ` (${errorCount} errors)` : ''}`);
      });
    }

    // Output
    if (args.json) {
      console.log(JSON.stringify(reports, null, 2));
    } else {
      printReport(reports);
    }

    const hasErrors = reports.some(r => !r.ok);
    process.exit(hasErrors ? 1 : 0);
  } catch (err) {
    console.error('Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
})();

function printReport (reports) {
  console.log('\n--- Integrity Check Report ---\n');

  let totalEvents = 0;
  let totalAccesses = 0;
  let totalErrors = 0;

  for (const r of reports) {
    totalEvents += r.events.checked;
    totalAccesses += r.accesses.checked;
    const errors = r.events.errors.length + r.accesses.errors.length;
    totalErrors += errors;

    if (errors > 0) {
      console.log(`User: ${r.username || r.userId} — FAILED`);
      for (const err of r.events.errors) {
        console.log(`  Event ${err.eventId}: ${err.error}`);
        if (err.expected) console.log(`    expected: ${err.expected}`);
        if (err.actual) console.log(`    actual:   ${err.actual}`);
      }
      for (const err of r.accesses.errors) {
        console.log(`  Access ${err.accessId}: ${err.error}`);
        if (err.expected) console.log(`    expected: ${err.expected}`);
        if (err.actual) console.log(`    actual:   ${err.actual}`);
      }
    }
  }

  console.log(`\nSummary: ${reports.length} users, ${totalEvents} events, ${totalAccesses} accesses checked`);
  if (totalErrors > 0) {
    console.log(`  ${totalErrors} integrity error(s) found`);
  } else {
    console.log('  All integrity checks passed');
  }
}

function parseArgs (argv) {
  const args = { user: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--user': case '-u': args.user = argv[++i]; break;
      case '--json': args.json = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        args.help = true;
    }
  }
  return args;
}

function printUsage () {
  console.log(`
Usage: node bin/integrity-check.js [options]

Options:
  --user, -u <userId>   Check a single user (default: all users)
  --json                Output report as JSON
  --help, -h            Show this help

Exit codes:
  0   All integrity checks passed
  1   One or more integrity errors found
`);
}
