#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Standalone CLI for data integrity verification.
// Recomputes integrity hashes on events and accesses and reports mismatches,
// and checks this core's copy of the platform DB (structure + duplicate keys).
//
// Usage:
//   node bin/integrity-check.js                    # check all users + the platform DB
//   node bin/integrity-check.js --user userId123   # check a single user
//   node bin/integrity-check.js --platform         # check the platform DB only
//   node bin/integrity-check.js --json             # output report as JSON

const path = require('path');
const { describePlatformIntegrity } = require('../storages/interfaces/platformStorage/PlatformDB.ts');

require('@pryv/boiler').init({
  appName: 'integrity-check',
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

    // Platform DB: this core's copy. Skipped for a single-user run.
    let platformReport = null;
    if (!args.user) {
      platformReport = await require('storages').platformDB.checkIntegrity();
      if (args.platform) {
        if (args.json) console.log(JSON.stringify(platformReport, null, 2));
        else printPlatformReport(platformReport);
        process.exit(platformReport.ok ? 0 : 1);
      }
    }

    const IntegrityCheck = require('business/src/integrity/IntegrityCheck.ts').default;
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
        log(`  ${userReportLine(report, userId)}`);
      });
    }

    // Output. The JSON output stays the array of user reports; a platform DB
    // failure goes to stderr there (use --platform --json for its report).
    if (args.json) {
      console.log(JSON.stringify(reports, null, 2));
      if (platformReport && !platformReport.ok) {
        console.error('Platform DB integrity FAILED: ' + JSON.stringify(platformReport));
      }
    } else {
      printReport(reports);
      if (platformReport) printPlatformReport(platformReport);
    }

    // Exit: 1 if any errors (users or platform DB), else 2 if any user could not be verified, else 0.
    const hasErrors = reports.some(r => !r.ok) || (platformReport != null && !platformReport.ok);
    const anyUnverified = reports.some(r => !r.verified);
    process.exit(hasErrors ? 1 : (anyUnverified ? 2 : 0));
  } catch (err) {
    console.error('Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
})();

/**
 * Per-user one-line status. [OK] only when everything was actually checked and
 * clean; [NOT VERIFIED] when a store was not checked (integrity inactive or store
 * unavailable) but no errors; [ERRORS] on integrity mismatches.
 */
function userReportLine (report, userId) {
  const name = report.username || userId;
  const detail = `events=${storeCheckDetail(report.events)} accesses=${storeCheckDetail(report.accesses)}`;
  if (!report.ok) {
    const errorCount = report.events.errors.length + report.accesses.errors.length;
    return `[ERRORS] ${name} — ${detail} (${errorCount} errors)`;
  }
  if (!report.verified) return `[NOT VERIFIED] ${name} — ${detail}`;
  return `[OK] ${name} — ${detail}`;
}

/** Checked count when the store was verified, or why it was not. */
function storeCheckDetail (store) {
  if (store.status === 'checked') return String(store.checked);
  if (store.status === 'inactive') return 'not verified (integrity inactive)';
  return 'not verified (store unavailable)';
}

function printReport (reports) {
  console.log('\n--- Integrity Check Report ---\n');

  let totalEvents = 0;
  let totalAccesses = 0;
  let totalErrors = 0;
  let unverified = 0;

  for (const r of reports) {
    totalEvents += r.events.checked;
    totalAccesses += r.accesses.checked;
    const errors = r.events.errors.length + r.accesses.errors.length;
    totalErrors += errors;
    if (!r.verified) unverified++;

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
  }
  if (unverified > 0) {
    console.log(`  ${unverified} of ${reports.length} user(s) NOT verified (integrity inactive or store unavailable)`);
  }
  if (totalErrors === 0 && unverified === 0) {
    console.log('  All integrity checks passed');
  }
}

function printPlatformReport (report) {
  console.log('\n--- Platform DB (this core) ---\n');
  for (const line of describePlatformIntegrity(report)) console.log(`  ${line}`);
}

function parseArgs (argv) {
  const args = { user: null, platform: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--user': case '-u': args.user = argv[++i]; break;
      case '--platform': args.platform = true; break;
      case '--json': args.json = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        args.help = true;
    }
  }
  if (args.user && args.platform) {
    console.error('--user and --platform are exclusive');
    args.help = true;
  }
  return args;
}

function printUsage () {
  console.log(`
Usage: node bin/integrity-check.js [options]

Options:
  --user, -u <userId>   Check a single user (default: all users and the platform DB)
  --platform            Check this core's copy of the platform DB only
  --json                Output report as JSON
  --help, -h            Show this help

Exit codes:
  0   All users verified and passed
  1   One or more integrity errors found (users or platform DB)
  2   One or more users could not be verified (integrity inactive or store unavailable)
`);
}
