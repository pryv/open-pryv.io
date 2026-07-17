#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// OAuth2 — app-account promotion CLI (curated registration mode).
//
// This is the only operator-CLI path for OAuth client
// registration. The HTTP POST /oauth2/register endpoint (RFC 7591
// dynamic registration in `mode: open`) is intentionally deferred —
// see the project backlog.
//
// `create` is promotion-only: the user account must already exist
// (created via the regular /reg/users flow). The CLI exits 1 with a
// clear error if the username doesn't resolve.
//
// Usage:
//   node bin/oauth-client.js create <username> [--redirect-uri <uri>]... [--scope <s>] [--name <s>] [--logo-uri <s>] [--client-uri <s>] [--application-type web|native]
//   node bin/oauth-client.js list
//   node bin/oauth-client.js show <clientId>
//   node bin/oauth-client.js update <clientId> [--redirect-uri <uri>]... [--scope <s>] ...
//   node bin/oauth-client.js revoke <clientId>

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'oauth-client',
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
    const { persistClient, removeClient, listClientIds, getClient } = require('oauth2');

    switch (args.command) {
      case 'create':
        await runCreate(platform, args, persistClient);
        break;
      case 'show':
        await runShow(platform, args, getClient);
        break;
      case 'list':
        await runList(platform, listClientIds);
        break;
      case 'update':
        await runUpdate(platform, args, getClient, persistClient);
        break;
      case 'revoke':
        await runRevoke(platform, args, removeClient);
        break;
      case 'rotate-secret':
        await runRotateSecret(platform, args, getClient, persistClient);
        break;
      default:
        console.error('Unknown command: ' + args.command);
        printUsage(process.stderr);
        process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error: ' + (err.message ?? err));
    if (process.env.DEBUG === '1') console.error(err.stack);
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runCreate (platform, args, persistClient) {
  const username = args.positional[0];
  if (!username) throw new Error('create: <username> required');

  const userExists = await usernameExists(username);
  if (!userExists) {
    throw new Error(
      'create: user "' + username + '" not found.\n' +
      'Promotion-only: create the user via /reg/users first, then re-run this command.\n' +
      'operator policy: register the user first, then promote it.'
    );
  }

  if (!args.flags['redirect-uri'] || args.flags['redirect-uri'].length === 0) {
    throw new Error('create: at least one --redirect-uri is required');
  }

  const clientId = username; // App account's username IS the client_id,
  const grantTypes = (args.flags['grant-type'] && args.flags['grant-type'].length > 0)
    ? args.flags['grant-type']
    : ['authorization_code', 'refresh_token'];

  await persistClient(platform, {
    clientId,
    redirectUris: args.flags['redirect-uri'],
    scope: args.flags['scope'] ?? [],
    clientName: args.flagsScalar['name'] ?? username,
    clientUri: args.flagsScalar['client-uri'],
    logoUri: args.flagsScalar['logo-uri'],
    grantTypes,
    applicationType: args.flagsScalar['application-type'] === 'native' ? 'native' : 'web',
    accountUsername: username,
    cmcOffers: parseCmcOffers(args.flags['cmc-offer']),
  });

  console.log('OK   client created: ' + clientId);
  console.log('     redirect_uris: ' + args.flags['redirect-uri'].join(', '));
  console.log('     grant_types:   ' + grantTypes.join(', '));
  console.log();
  console.log('NOTE: this writes the PlatformDB cache row only. The full');
  console.log('      App-account :_app:* stream sync lands when the grant');
  console.log('      handlers are wired.');
}

async function runShow (platform, args, getClient) {
  const clientId = args.positional[0];
  if (!clientId) throw new Error('show: <clientId> required');
  const client = await getClient(platform, clientId);
  if (!client) {
    console.error('NOT FOUND: ' + clientId);
    process.exit(2);
  }
  console.log(JSON.stringify(client, null, 2));
}

async function runList (platform, listClientIds) {
  const ids = await listClientIds(platform);
  if (ids.length === 0) {
    console.log('(no clients registered)');
    return;
  }
  for (const id of ids) console.log(id);
}

async function runUpdate (platform, args, getClient, persistClient) {
  const clientId = args.positional[0];
  if (!clientId) throw new Error('update: <clientId> required');
  const existing = await getClient(platform, clientId);
  if (!existing) throw new Error('update: client "' + clientId + '" not found');

  const merged = {
    ...existing,
    redirectUris: args.flags['redirect-uri'] ?? existing.redirectUris,
    scope: args.flags['scope'] ?? existing.scope,
    clientName: args.flagsScalar['name'] ?? existing.clientName,
    clientUri: args.flagsScalar['client-uri'] ?? existing.clientUri,
    logoUri: args.flagsScalar['logo-uri'] ?? existing.logoUri,
    grantTypes: args.flags['grant-type'] ?? existing.grantTypes,
    applicationType: args.flagsScalar['application-type'] === 'native'
      ? 'native'
      : (args.flagsScalar['application-type'] === 'web' ? 'web' : existing.applicationType),
    cmcOffers: args.flags['cmc-offer'] != null
      ? parseCmcOffers(args.flags['cmc-offer'])
      : existing.cmcOffers,
  };
  await persistClient(platform, merged);
  console.log('OK   client updated: ' + clientId);
}

async function runRevoke (platform, args, removeClient) {
  const clientId = args.positional[0];
  if (!clientId) throw new Error('revoke: <clientId> required');
  if (!args.flags['yes'] && !args.flagsScalar['yes']) {
    throw new Error('revoke: refuses to run without --yes (operator-revoke is a footgun, see)');
  }
  await removeClient(platform, clientId);
  console.log('OK   client revoked: ' + clientId);
  console.log();
  console.log('NOTE: PlatformDB cache row removed. Cluster-wide access-cache');
  console.log('      invalidation via the OAUTH_CLIENT_REVOKE pubsub channel');
  console.log('      lands with the grant handlers.');
}

async function runRotateSecret (platform, args, getClient, persistClient) {
  const clientId = args.positional[0];
  if (!clientId) throw new Error('rotate-secret: <clientId> required');
  const existing = await getClient(platform, clientId);
  if (!existing) throw new Error('rotate-secret: client "' + clientId + '" not found');

  const { mintSecret } = require('oauth2/src/clientSecret.ts');
  const { plaintext, hash } = await mintSecret();

  await persistClient(platform, { ...existing, clientSecretHash: hash });

  console.log('OK   client_secret rotated for: ' + clientId);
  console.log();
  console.log('client_id:     ' + clientId);
  console.log('client_secret: ' + plaintext);
  console.log();
  console.log('SHOWN ONCE. Store it now in the consuming app. The hash is');
  console.log('persisted; the plaintext is never written to disk or logs.');
  console.log('Re-run this command to mint a new secret (invalidates the old one).');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initPlatform () {
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();
  const storages = require('storages');
  await storages.init(config);
  // Use the raw PlatformDB directly (same pattern as /reg/access); the
  // Platform.ts wrapper exposes only a curated subset of methods.
  return storages.platformDB;
}

// `--cmc-offer <name>=<capabilityUrl>` values → cmcOffers map.
// Deep validation (name grammar, URL shape, scope consistency) happens
// in persistClient; this only splits on the first '='.
function parseCmcOffers (values) {
  if (values == null || values.length === 0) return undefined;
  const offers = {};
  for (const v of values) {
    const eq = v.indexOf('=');
    if (eq < 1) throw new Error('--cmc-offer expects <name>=<capabilityUrl>, got: ' + v);
    offers[v.slice(0, eq)] = { capabilityUrl: v.slice(eq + 1) };
  }
  return offers;
}

async function usernameExists (username) {
  const { getUsersLocalIndex } = require('storage');
  const usersIndex = await getUsersLocalIndex();
  return await usersIndex.usernameExists(username);
}

function parseArgs (argv) {
  const result = { command: null, positional: [], flags: {}, flagsScalar: {} };
  let i = 0;
  result.command = argv[i++] ?? null;
  while (i < argv.length) {
    const arg = argv[i++];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = (i < argv.length && !argv[i].startsWith('--')) ? argv[i++] : true;
      if (val === true) {
        result.flagsScalar[key] = true;
      } else {
        // Multi-valued flags: --redirect-uri, --scope, --grant-type, --cmc-offer
        if (key === 'redirect-uri' || key === 'scope' || key === 'grant-type' || key === 'cmc-offer') {
          if (!result.flags[key]) result.flags[key] = [];
          result.flags[key].push(val);
        } else {
          result.flagsScalar[key] = val;
        }
      }
    } else {
      result.positional.push(arg);
    }
  }
  return result;
}

function printUsage (stream) {
  stream.write(
    'OAuth2 client (app-account) management CLI\n\n' +
    'Usage:\n' +
    '  node bin/oauth-client.js create <username> --redirect-uri <uri> [more flags]\n' +
    '  node bin/oauth-client.js show <clientId>\n' +
    '  node bin/oauth-client.js list\n' +
    '  node bin/oauth-client.js update <clientId> [flags]\n' +
    '  node bin/oauth-client.js revoke <clientId> --yes\n' +
    '  node bin/oauth-client.js rotate-secret <clientId>\n\n' +
    'Flags (create / update):\n' +
    '  --redirect-uri <uri>      (multi-valued; at least one required on create)\n' +
    '  --scope <scope-token>     (multi-valued; e.g. cmc:<offer-name> — pair with --cmc-offer)\n' +
    '  --grant-type <name>       (multi-valued; default authorization_code,refresh_token)\n' +
    '  --name <human-name>       client_name shown on the consent screen\n' +
    '  --client-uri <uri>        client_uri shown on the consent screen\n' +
    '  --logo-uri <uri>          logo_uri shown on the consent screen\n' +
    '  --application-type web|native\n' +
    '  --cmc-offer <name>=<capabilityUrl>\n' +
    '                            (multi-valued) register a consent-offer reference for\n' +
    '                            granular scope: the app account publishes an open-link\n' +
    '                            consent/request-cmc offer, then registers its capability\n' +
    '                            URL here; clients request it as scope "cmc:<name>"\n' +
    '                            (add the token to --scope as well)\n\n' +
    'Notes:\n' +
    '  - create requires the user to ALREADY exist(promotion-only).\n' +
    '  - revoke requires --yes (operator footgun protection;).\n' +
    '  - HTTP `POST /oauth2/register` (RFC 7591 mode:open) is intentionally deferred.\n'
  );
}
