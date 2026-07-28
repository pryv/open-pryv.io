#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// CLI for managing observability configuration directly in PlatformDB.
// Works whether the master process is running or not — a rolling restart
// of cores is required for changes to take effect (workers receive the
// resolved posture from master at fork time).
//
// Usage:
//   node bin/observability.js show
//   node bin/observability.js enable
//   node bin/observability.js disable
//   node bin/observability.js set-endpoint <url>
//   node bin/observability.js set-header <name> <value>
//   node bin/observability.js clear-headers
//   node bin/observability.js set-interval <seconds>   # 60-3600, default 300
//   node bin/observability.js set-app-name <name>
//
// Telemetry is shipped over OTLP/HTTP, so the destination is a URL and
// whatever auth header that backend expects: New Relic wants `api-key`,
// others want `Authorization`. Headers are stored AES-256-GCM encrypted
// at rest (HKDF key material derived from auth.adminAccessKey) because
// they carry the credential; `show` never echoes their values.

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
      case 'set-app-name':
        await runSetAppName(platform, args);
        break;
      case 'set-endpoint':
        await runSetEndpoint(platform, args);
        break;
      case 'set-header':
        await runSetHeader(platform, args);
        break;
      case 'clear-headers':
        await runClearHeaders(platform);
        break;
      case 'set-interval':
        await runSetInterval(platform, args);
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
  const rqliteUrl = config.get('storages:engines:rqlite:url') || 'http://localhost:4001';
  await waitForRqlite(rqliteUrl);
  // The storages barrel opens the user-data (baseStorage) connection before it
  // reaches PlatformDB, so this CLI cannot run without user-data credentials
  // even though it only ever touches PlatformDB rows. When that connection is
  // the thing that failed, say so plainly: the raw driver message (e.g. a SASL
  // complaint about a non-string password) reads like a PlatformDB problem and
  // sends operators looking in the wrong place.
  try {
    await require('storages').init(config);
  } catch (err) {
    throw new Error(
      'could not initialise storage engines: ' + err.message +
      '\nThis CLI only reads and writes PlatformDB, but engine start-up opens the' +
      '\nuser-data storage connection first, so it needs those credentials too.' +
      '\nCheck the baseStorage engine settings for this core (host, port, user,' +
      '\npassword) in the config this process loaded, then retry.'
    );
  }
  const { getPlatform } = require('platform');
  return await getPlatform();
}

// Wait until rqlited's HTTP API answers. The CLI is typically run with
// `dokku enter web` right after a restart, when rqlited is still coming up
// — without this, the first PlatformDB call surfaces an opaque `fetch failed`.
async function waitForRqlite (url, timeoutMs = 30000) {
  const readyzUrl = url.replace(/\/$/, '') + '/readyz';
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(readyzUrl);
      if (res.ok) return;
    } catch (_) { /* not ready — fall through to retry */ }
    if (!notified) {
      console.error(`Waiting for PlatformDB (rqlited) at ${url} …`);
      notified = true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(
    `PlatformDB (rqlited) not reachable at ${url} after ${timeoutMs}ms.\n` +
    '  Hint: rqlited runs inside the web.1 container only; `dokku run` spawns\n' +
    '  a fresh container without it. Use `dokku enter <app> web` and retry\n' +
    '  once the master log shows "Startup sequence complete".'
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runShow (platform) {
  const obs = await platform.getObservabilityConfig();
  const headerNames = Object.keys(obs.otlp.headers || {});
  console.log('enabled:          ' + obs.enabled);
  console.log('appName:          ' + obs.appName);
  console.log('hostname:         ' + obs.hostname);
  console.log('otlp endpoint:    ' + (obs.otlp.endpoint || '(unset)'));
  console.log('otlp headers set: ' + (headerNames.length > 0 ? headerNames.join(', ') + ' (values hidden)' : 'none'));
  console.log('report interval:  ' + (obs.otlp.flushIntervalSeconds != null
    ? obs.otlp.flushIntervalSeconds + 's'
    : '300s (default)'));
  console.log('');
  // What leaves the deployment, restated here so an operator can answer
  // "what does the backend see?" without reading source.
  console.log('Data sent to the backend:');
  console.log('  sent:     per-method call counts, durations and error counts');
  console.log('            (API method ids, status classes, error codes),');
  console.log('            this MACHINE hostname (never a user-facing host),');
  console.log('            worker id, service name and version, and');
  console.log('            stack traces for server-side faults');
  console.log('  NOT sent: request URLs, query parameters, request bodies,');
  console.log('            headers, usernames, event data, log messages and');
  console.log('            error messages — none of these have a representation');
  console.log('            in the emitted schema, so they cannot be sent');
  console.log('  Authoritative list: the allow-list in');
  console.log('  components/business/src/observability/schema.ts');
  console.log('');

  // Cross-reference against the boot-log [platform-config-snapshot] line.
  // Same snapshot, same hash — operators compare hashes across cores to
  // detect platform-wide config drift without inspecting the secret.
  const { snapshot, hash } = platform.getPlatformConfigSnapshot();
  console.log('platform-config-snapshot hash: ' + hash);
  console.log('platform-config-snapshot:      ' + JSON.stringify(snapshot));
  console.log('');
  console.log('Note: configuration changes require a rolling restart of all cores.');
}

async function runEnable (platform) {
  const current = await platform.getObservabilityConfig();
  if (!current.otlp.endpoint) {
    console.error('Warning: no endpoint is set. Run `set-endpoint <URL>` first.');
    console.error('         Telemetry will not activate until an endpoint is stored.');
  }
  await platform.setObservabilityValue('enabled', true);
  console.log('observability enabled');
  console.log('Rolling restart cores to pick up the change.');
}

async function runDisable (platform) {
  await platform.setObservabilityValue('enabled', false);
  console.log('observability disabled in PlatformDB');
  console.log('Rolling restart cores to pick up the change.');
}

async function runSetEndpoint (platform, args) {
  if (!args.endpoint) throw new Error('set-endpoint: url argument is required');
  // Same rule the emitter applies at startup, so the CLI cannot be the only
  // thing standing between cleartext telemetry and the public internet.
  const { endpointRefusal } = require('business/src/observability/endpointPolicy.ts');
  const refusal = endpointRefusal(args.endpoint);
  if (refusal != null) throw new Error('set-endpoint: ' + refusal);
  await platform.setObservabilityValue('otlp-endpoint', args.endpoint);
  console.log('observability OTLP endpoint set to "' + args.endpoint + '"');
  console.log('The standard OTLP/HTTP paths /v1/metrics and /v1/logs are appended to it.');
  console.log('Rolling restart cores to pick up the change.');
}

async function runSetHeader (platform, args) {
  if (!args.headerName) throw new Error('set-header: name argument is required');
  if (!args.headerValue) throw new Error('set-header: value argument is required');
  const current = await platform.getObservabilityConfig();
  const headers = Object.assign({}, current.otlp.headers || {});
  headers[args.headerName] = args.headerValue;
  await platform.setObservabilityValue('otlp-headers', JSON.stringify(headers));
  console.log('observability OTLP header "' + args.headerName + '" stored (AES-256-GCM encrypted at rest)');
  console.log('Rolling restart cores to pick up the change.');
}

async function runSetInterval (platform, args) {
  const seconds = Number(args.seconds);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 3600) {
    throw new Error('set-interval: expected a number of seconds between 60 and 3600 (got "' +
      (args.seconds || '') + '")');
  }
  await platform.setObservabilityValue('otlp-flush-interval', String(Math.round(seconds)));
  console.log('observability reporting interval set to ' + Math.round(seconds) + 's');
  console.log('');
  console.log('This is a privacy control: it sets how finely activity is observable.');
  console.log('Error reports are grouped per interval and stamped at its boundary, so a');
  console.log('longer interval reduces the residual chance that a single report on a');
  console.log('low-traffic instance correlates to a single user. Shorter means faster');
  console.log('alerting. Default 300s.');
  console.log('Rolling restart cores to pick up the change.');
}

async function runClearHeaders (platform) {
  await platform.setObservabilityValue('otlp-headers', JSON.stringify({}));
  console.log('observability OTLP headers cleared');
  console.log('Rolling restart cores to pick up the change.');
}

async function runSetAppName (platform, args) {
  if (!args.appName) throw new Error('set-app-name: name argument is required');
  await platform.setObservabilityValue('app-name', args.appName);
  console.log('observability app name set to "' + args.appName + '"');
  console.log('Rolling restart cores to pick up the change.');
}

// ---------------------------------------------------------------------------
// Parse + help
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const args = { command: null };
  const positional = argv.filter(a => !a.startsWith('--'));
  args.command = positional[0];

  switch (args.command) {
    case 'set-app-name':
      args.appName = positional[1];
      break;
    case 'set-endpoint':
      args.endpoint = positional[1];
      break;
    case 'set-header':
      args.headerName = positional[1];
      args.headerValue = positional[2];
      break;
    case 'set-interval':
      args.seconds = positional[1];
      break;
  }
  return args;
}

function printUsage (stream) {
  stream.write('Usage:\n');
  stream.write('  observability show\n');
  stream.write('  observability enable\n');
  stream.write('  observability disable\n');
  stream.write('  observability set-endpoint <url>\n');
  stream.write('  observability set-header <name> <value>\n');
  stream.write('  observability clear-headers\n');
  stream.write('  observability set-interval <seconds>   # 60-3600, default 300\n');
  stream.write('  observability set-app-name <name>\n');
  stream.write('\n');
  stream.write('Telemetry ships over OTLP/HTTP: set the backend base URL with\n');
  stream.write('set-endpoint, and whatever auth header it expects with set-header\n');
  stream.write('(e.g. "api-key" for New Relic, "Authorization" elsewhere).\n');
  stream.write('Headers are stored AES-256-GCM encrypted in PlatformDB and are\n');
  stream.write('never echoed back. Changes require a rolling restart of all cores.\n');
}
