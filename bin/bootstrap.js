#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// CLI for issuing bootstrap bundles to new cores joining a Pryv.io cluster.
// Runs on an existing core that holds the cluster CA private key.
//
// Usage:
//   node bin/bootstrap.js new-core --id <coreId> --ip <ip>
//                                  [--url <url>] [--hosting <h>]
//                                  [--out <path>] [--token-ttl <ms>]
//                                  [--ca-dir <path>] [--tokens-path <path>]
//   node bin/bootstrap.js list-tokens [--tokens-path <path>]
//   node bin/bootstrap.js revoke-token <coreId> [--ip <ip>]
//                                               [--tokens-path <path>]
//
// All orchestration lives in business/src/bootstrap/cliOps.js — this file
// only handles argv parsing, config loading and operator-facing output.

const path = require('node:path');

if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'bootstrap',
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

    switch (args.command) {
      case 'new-core': await runNewCore(args); break;
      case 'list-tokens': await runListTokens(args); break;
      case 'revoke-token': await runRevokeToken(args); break;
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

const DEFAULT_CA_DIR = '/etc/pryv/ca';
const DEFAULT_TOKENS_PATH = '/var/lib/pryv/bootstrap-tokens.json';

async function runNewCore (args) {
  if (!args.id) throw new Error('new-core: --id is required');
  if (!args.ip) throw new Error('new-core: --ip is required');

  const { cliOps } = require('business/src/bootstrap');
  const config = await getConfig();
  const ctx = resolveContext(config, args);
  const platformDB = await initPlatformDB(config);
  const outPath = args.out || path.resolve(process.cwd(), `bootstrap-${args.id}.json.age`);
  const ttlMs = parseTtl(args['token-ttl']);

  const result = await cliOps.newCore({
    platformDB,
    caDir: ctx.caDir,
    tokensPath: ctx.tokensPath,
    dnsDomain: ctx.dnsDomain,
    ackUrlBase: ctx.ackUrlBase,
    secrets: ctx.secrets,
    rqlite: ctx.rqlite,
    coreId: args.id,
    ip: args.ip,
    url: args.url || null,
    hosting: args.hosting || null,
    outPath,
    ttlMs
  });

  console.log('');
  console.log('Bundle written:');
  console.log('  file       : ' + result.outPath);
  console.log('  passphrase : ' + result.passphrase);
  console.log('  expires    : ' + new Date(result.expiresAt).toISOString());
  console.log('  ack URL    : ' + result.ackUrl);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Transfer the bundle file AND passphrase to the new core');
  console.log('     out-of-band (different channel from the file itself).');
  console.log('  2. On the new core: bin/master.js --bootstrap <file>');
  if (result.caCreated) {
    console.log('  3. BACK UP ' + ctx.caDir + ' on this host — losing the CA');
    console.log('     private key prevents adding any further cores.');
  }
}

async function runListTokens (args) {
  const { cliOps } = require('business/src/bootstrap');
  const config = await getConfig();
  const tokensPath = args['tokens-path'] || config.get('cluster:tokens:path') || DEFAULT_TOKENS_PATH;

  const rows = cliOps.listTokens({ tokensPath });
  if (rows.length === 0) {
    console.log('(no active join tokens)');
    return;
  }
  console.log('coreId           expiresAt                  issuedAt');
  for (const r of rows) {
    console.log(
      r.coreId.padEnd(16) + ' ' +
      new Date(r.expiresAt).toISOString() + '  ' +
      new Date(r.issuedAt).toISOString()
    );
  }
}

async function runRevokeToken (args) {
  if (!args.coreId) throw new Error('revoke-token: <coreId> is required');
  const { cliOps } = require('business/src/bootstrap');
  const config = await getConfig();
  const tokensPath = args['tokens-path'] || config.get('cluster:tokens:path') || DEFAULT_TOKENS_PATH;

  const platformDB = args.ip ? await initPlatformDB(config) : null;
  const result = await cliOps.revokeToken({
    tokensPath,
    coreId: args.coreId,
    platformDB,
    ip: args.ip || null
  });

  console.log(`Revoked ${result.tokensRevoked} active token(s) for ${args.coreId}.`);
  if (result.unregister) {
    const u = result.unregister;
    console.log(
      `Cleaned up DNS/PlatformDB: coreInfoDeleted=${u.coreInfoDeleted}, ` +
      `perCoreDeleted=${u.perCoreDeleted}, lscIpsAfter=[${u.lscIpsAfter.join(',')}]`
    );
  } else {
    console.log('(skip DNS/PlatformDB cleanup: pass --ip <ip> to remove pre-registration)');
  }
}

// ---------------------------------------------------------------------------
// Init helpers
// ---------------------------------------------------------------------------

async function getConfig () {
  const { getConfig } = require('@pryv/boiler');
  return await getConfig();
}

async function initPlatformDB (config) {
  await require('storages').init(config);
  const { getPlatform } = require('platform');
  return await getPlatform();
}

/**
 * Pull everything new-core needs out of config + flags into a single object.
 * Fails loudly when a required platform secret is still on its placeholder.
 */
function resolveContext (config, args) {
  const caDir = args['ca-dir'] || config.get('cluster:ca:path') || DEFAULT_CA_DIR;
  const tokensPath = args['tokens-path'] || config.get('cluster:tokens:path') || DEFAULT_TOKENS_PATH;

  const dnsDomain = config.get('dns:domain') || null;
  const ackUrlBase =
    config.get('core:url') ||
    config.get('dnsLess:publicUrl') ||
    null;
  if (!ackUrlBase) {
    throw new Error('Cannot derive ack URL: set core.url or dnsLess.publicUrl in config');
  }

  const adminAccessKey = config.get('auth:adminAccessKey');
  const filesReadTokenSecret = config.get('auth:filesReadTokenSecret');
  if (!isUsableSecret(adminAccessKey)) {
    throw new Error('auth.adminAccessKey is not set (still on placeholder); cannot ship a bundle.');
  }
  if (!isUsableSecret(filesReadTokenSecret)) {
    throw new Error('auth.filesReadTokenSecret is not set (still on placeholder); cannot ship a bundle.');
  }

  const raftPort = config.get('storages:engines:rqlite:raftPort') ?? 4002;
  const httpPort = httpPortFromUrl(config.get('storages:engines:rqlite:url')) ?? 4001;

  return {
    caDir,
    tokensPath,
    dnsDomain,
    ackUrlBase,
    secrets: { adminAccessKey, filesReadTokenSecret },
    rqlite: { raftPort, httpPort }
  };
}

function isUsableSecret (v) {
  return typeof v === 'string' && v.length > 0 && v !== 'REPLACE ME';
}

function httpPortFromUrl (url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    if (u.protocol === 'https:') return 443;
    if (u.protocol === 'http:') return 80;
    return null;
  } catch {
    return null;
  }
}

function parseTtl (raw) {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('--token-ttl must be a positive integer (ms)');
  }
  return n;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const out = { command: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  out.command = positional[0] || null;
  if (out.command === 'revoke-token') out.coreId = positional[1] || null;
  return out;
}

function printUsage (stream = process.stderr) {
  stream.write(
`Usage:
  node bin/bootstrap.js new-core --id <coreId> --ip <ip>
                                 [--url <url>] [--hosting <h>]
                                 [--out <path>] [--token-ttl <ms>]
                                 [--ca-dir <path>] [--tokens-path <path>]
  node bin/bootstrap.js list-tokens [--tokens-path <path>]
  node bin/bootstrap.js revoke-token <coreId> [--ip <ip>]
                                              [--tokens-path <path>]

Flags:
  --id            new core's identifier (required for new-core)
  --ip            new core's public IP   (required for new-core; optional for revoke-token)
  --url           explicit core.url for the new core (DNSless multi-core)
  --hosting       hosting region label, surfaced in /reg/hostings
  --out           bundle output path (default: ./bootstrap-<id>.json.age)
  --token-ttl     join-token lifetime in ms (default: 24h)
  --ca-dir        CA directory (default: /etc/pryv/ca or cluster.ca.path)
  --tokens-path   token-store JSON file (default: /var/lib/pryv/bootstrap-tokens.json
                   or cluster.tokens.path)
  -h, --help      print this help
`);
}
