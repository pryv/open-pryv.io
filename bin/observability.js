#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// CLI for managing observability (APM) configuration directly in PlatformDB.
// Works whether the master process is running or not — a rolling restart of
// cores is required for changes to the license key / provider to take effect
// (the agent reads its license key once at require() time).
//
// Usage:
//   node bin/observability.js show
//   node bin/observability.js enable <provider>          # e.g. "newrelic"
//   node bin/observability.js disable
//   node bin/observability.js set-log-level <level>      # error | warn | info | debug
//   node bin/observability.js set-app-name <name>
//   node bin/observability.js newrelic set-license-key <key>
//
// The license key is stored AES-256-GCM encrypted at rest (HKDF key
// material derived from auth.adminAccessKey); the `show` command never
// echoes secret values.

const path = require('path');

// Handle --help before boiler init.
if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'observability-cli',
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
    if (args.command == null) {
      printUsage(process.stderr);
      process.exit(1);
    }

    const platform = await initPlatform();

    switch (args.command) {
      case 'show':
        await runShow(platform);
        break;
      case 'enable':
        await runEnable(platform, args);
        break;
      case 'disable':
        await runDisable(platform);
        break;
      case 'set-log-level':
        await runSetLogLevel(platform, args);
        break;
      case 'set-app-name':
        await runSetAppName(platform, args);
        break;
      case 'newrelic':
        await runNewrelic(platform, args);
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

async function runShow (platform) {
  const obs = await platform.getObservabilityConfig();
  const licenseKeySet = !!obs.newrelic.licenseKey;
  console.log('enabled:          ' + obs.enabled);
  console.log('provider:         ' + (obs.provider || '(unset)'));
  console.log('appName:          ' + obs.appName);
  console.log('logLevel:         ' + obs.logLevel);
  console.log('hostname:         ' + obs.hostname);
  console.log('newrelic licenseKey set: ' + (licenseKeySet ? 'yes' : 'no'));
  console.log('');
  console.log('Note: license key rotation requires a rolling restart of all cores.');
}

async function runEnable (platform, args) {
  if (!args.provider) throw new Error('enable: provider argument is required (e.g. "newrelic")');
  if (args.provider !== 'newrelic') {
    throw new Error('enable: only "newrelic" is currently supported (got "' + args.provider + '")');
  }
  const current = await platform.getObservabilityConfig();
  if (!current.newrelic.licenseKey) {
    console.error('Warning: no license key is set. Run `newrelic set-license-key <KEY>` first.');
    console.error('         Observability will not activate until a valid key is stored.');
  }
  await platform.setObservabilityValue('provider', args.provider);
  await platform.setObservabilityValue('enabled', true);
  console.log('observability enabled (provider=' + args.provider + ')');
  console.log('Rolling restart cores to pick up the change.');
}

async function runDisable (platform) {
  await platform.setObservabilityValue('enabled', false);
  console.log('observability disabled in PlatformDB');
  console.log('Rolling restart cores to pick up the change.');
}

async function runSetLogLevel (platform, args) {
  const level = args.level;
  if (!['error', 'warn', 'info', 'debug'].includes(level)) {
    throw new Error('set-log-level: level must be one of error | warn | info | debug (got "' + level + '")');
  }
  await platform.setObservabilityValue('log-level', level);
  console.log('observability log level set to "' + level + '"');
  console.log('Rolling restart cores to pick up the change.');
}

async function runSetAppName (platform, args) {
  if (!args.appName) throw new Error('set-app-name: name argument is required');
  await platform.setObservabilityValue('app-name', args.appName);
  console.log('observability app name set to "' + args.appName + '"');
  console.log('Rolling restart cores to pick up the change.');
}

async function runNewrelic (platform, args) {
  if (args.subcommand === 'set-license-key') {
    if (!args.licenseKey) throw new Error('newrelic set-license-key: key argument is required');
    if (args.licenseKey.length < 20) {
      throw new Error('newrelic set-license-key: key looks too short (got ' + args.licenseKey.length + ' chars; expected ~40)');
    }
    await platform.setObservabilityValue('newrelic-license-key', args.licenseKey);
    console.log('newrelic license key rotated in PlatformDB (AES-256-GCM encrypted at rest)');
    console.log('Rolling restart cores to pick up the change.');
    return;
  }
  throw new Error('newrelic: unknown subcommand "' + (args.subcommand || '') + '" (expected "set-license-key")');
}

// ---------------------------------------------------------------------------
// Parse + help
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const args = { command: null };
  const positional = argv.filter(a => !a.startsWith('--'));
  args.command = positional[0];

  switch (args.command) {
    case 'enable':
      args.provider = positional[1];
      break;
    case 'set-log-level':
      args.level = positional[1];
      break;
    case 'set-app-name':
      args.appName = positional[1];
      break;
    case 'newrelic':
      args.subcommand = positional[1];
      args.licenseKey = positional[2];
      break;
  }
  return args;
}

function printUsage (stream) {
  stream.write('Usage:\n');
  stream.write('  observability show\n');
  stream.write('  observability enable <provider>\n');
  stream.write('  observability disable\n');
  stream.write('  observability set-log-level <error|warn|info|debug>\n');
  stream.write('  observability set-app-name <name>\n');
  stream.write('  observability newrelic set-license-key <key>\n');
  stream.write('\n');
  stream.write('The license key is stored AES-256-GCM encrypted in PlatformDB.\n');
  stream.write('Rotation requires a rolling restart of all cores.\n');
}
