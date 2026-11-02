#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// OAuth2 client CLI (curated registration mode): app-account promotion and
// registry clients.
//
// This is the only operator-CLI path for OAuth client
// registration. The HTTP POST /oauth2/register endpoint (RFC 7591
// dynamic registration in `mode: open`) is intentionally deferred.
//
// `create` is promotion-only: the user account must already exist
// (created via the regular /reg/users flow). The CLI exits 1 with a
// clear error if the username doesn't resolve.
//
// Usage:
//   node bin/oauth-client.js create <username> [--client-id <opaque-id>] [--redirect-uri <uri>]... [--scope <s>] [--name <s>] [--logo-uri <s>] [--client-uri <s>] [--application-type web|native]
//   node bin/oauth-client.js list
//   node bin/oauth-client.js show <clientId>
//   node bin/oauth-client.js update <clientId> [--redirect-uri <uri>]... [--scope <s>] ...
//   node bin/oauth-client.js revoke <clientId>
//   node bin/oauth-client.js revoke-key <jkt> --yes
//   node bin/oauth-client.js unrevoke-key <jkt> --yes
//   node bin/oauth-client.js list-revoked-keys
//   node bin/oauth-client.js list-keys [<clientId>]
//   node bin/oauth-client.js purge-grants <clientId> --yes

const path = require('path');

// The program runs only when this file is executed (see the end of the file);
// the command functions are exported for tests, run against a fake platform.
function main () {
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    printUsage(process.stdout);
    process.exit(0);
  }
  initBoiler();
  run();
}

function initBoiler () {
  require('@pryv/boiler').init({
    appName: 'oauth-client',
    baseFilesDir: path.resolve(__dirname, '../'),
    baseConfigDir: path.resolve(__dirname, '../config/'),
    extraConfigs: [{
      // stdout carries the command's output: logs go to stderr.
      scope: 'cli-logs-stderr',
      data: { logs: { console: { stderr: true } } }
    }, {
      scope: 'default-paths',
      file: path.resolve(__dirname, '../config/plugins/paths-config.js')
    }, {
      pluginAsync: require('../config/plugins/systemStreams')
    }, {
      plugin: require('../config/plugins/core-identity')
    }]
  });
}

async function run () {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command == null) {
      printUsage(process.stderr);
      process.exit(1);
    }

    const platform = await initPlatform();
    const {
      persistClient, removeClient, getClient,
      revokeDpopKey, unrevokeDpopKey, listRevokedDpopKeys, listDpopKeysSeen,
      computeThumbprint,
    } = require('oauth2');

    switch (args.command) {
      case 'create':
        await runCreate(platform, args, persistClient, getClient);
        break;
      case 'show':
        await runShow(platform, args, getClient, computeThumbprint);
        break;
      case 'list':
        await runList(platform, getClient);
        break;
      case 'update':
        await runUpdate(platform, args, getClient, persistClient);
        break;
      case 'revoke':
        await runRevoke(platform, args, removeClient);
        break;
      case 'revoke-key':
        await runRevokeKey(platform, args, revokeDpopKey);
        break;
      case 'unrevoke-key':
        await runUnrevokeKey(platform, args, unrevokeDpopKey);
        break;
      case 'list-revoked-keys':
        await runListRevokedKeys(platform, listRevokedDpopKeys);
        break;
      case 'list-keys':
        await runListKeys(platform, args, listDpopKeysSeen, listRevokedDpopKeys);
        break;
      case 'rotate-secret':
        await runRotateSecret(platform, args, getClient, persistClient);
        break;
      case 'create-registry':
        await runCreateRegistry(platform, args, persistClient, getClient);
        break;
      case 'suspend':
      case 'resume':
        await runSetStatus(platform, args, getClient, persistClient);
        break;
      case 'purge-grants':
        await runPurgeGrants(platform, args, cliEnv.purgeClientGrants);
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
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runCreate (platform, args, persistClient, getClient) {
  checkFlags(args, 'create', CREATE_FLAGS);
  const username = args.positional[0];
  if (!username) throw new Error('create: <username> required');

  // The client row stores the account's user id, which only its home core
  // can resolve (the local users index): create runs on that core.
  const accountUserId = await localUserId(username);
  if (accountUserId == null) {
    const hostingCore = await hostingCoreOf(username);
    const { getConfig } = require('@pryv/boiler');
    const selfCore = String((await getConfig()).get('core:id') ?? 'single');
    if (hostingCore != null && hostingCore === selfCore) {
      throw new Error(
        'create: the platform maps user "' + username + '" to THIS core, but its local index\n' +
        'does not know it (user-core drift). Run bin/reconcile-user-cores.js, then retry.'
      );
    }
    if (hostingCore != null) {
      throw new Error(
        'create: user "' + username + '" is hosted on core "' + hostingCore + '", not this one.\n' +
        'Run this command on that core: the client record stores the account\'s user id,\n' +
        'which only its home core can resolve.'
      );
    }
    throw new Error(
      'create: user "' + username + '" not found.\n' +
      'Promotion-only: create the user via /reg/users first, then re-run this command.\n' +
      'operator policy: register the user first, then promote it.'
    );
  }

  if (!args.flags['redirect-uri'] || args.flags['redirect-uri'].length === 0) {
    throw new Error('create: at least one --redirect-uri is required');
  }

  // The client_id defaults to the app account's username, which keeps every
  // existing deployment working. An operator whose platform hashes usernames
  // passes an opaque one instead: the id is a key in the replicated platform
  // store (the client row, its revocation tombstone, the DPoP keys seen) and
  // travels on the wire, so with the default the username does too, whatever
  // the platform's PII mode.
  const givenId = args.flagsScalar['client-id'];
  if (givenId === true) throw new Error('create: --client-id requires a value');
  const clientId = givenId ?? username;
  const idError = oauthStorage().clientIdError(clientId);
  if (idError != null) {
    throw new Error('create: ' + (givenId != null
      ? idError.replace('client_id', '--client-id')
      : idError + ' (the account name is used as the client_id; pass --client-id <opaque-id>)'));
  }
  if (givenId != null) {
    if (await getClient(platform, clientId) != null) {
      throw new Error('create: client "' + clientId + '" already exists; pick another --client-id or revoke it first');
    }
    // An id that is also a username would be re-pointed at that account the
    // day someone runs `create <that-user>`, silently moving the client to it.
    if (clientId !== username && (await localUserId(clientId) != null || await hostingCoreOf(clientId) != null)) {
      throw new Error(
        'create: "' + clientId + '" is an account name on this platform; a client_id must not be one.\n' +
        'Pick an id no username can take (usernames are lowercase letters, digits and "-",\n' +
        'so any id with an uppercase letter, a "." or a "~" is safe).'
      );
    }
  } else {
    // Re-running create on an existing client is how an operator rewrites a
    // record, but doing it on a row pointing at a DIFFERENT account would
    // hand that account's client to this one.
    const existing = await getClient(platform, clientId);
    if (existing != null && typeof existing.accountUserId === 'string' &&
        existing.accountUserId.length > 0 && existing.accountUserId !== accountUserId) {
      throw new Error('create: client "' + clientId + '" already exists and points at another account; revoke it first');
    }
  }
  const grantTypes = (args.flags['grant-type'] && args.flags['grant-type'].length > 0)
    ? args.flags['grant-type']
    : ['authorization_code', 'refresh_token'];
  const jwks = resolveJwks(args); // undefined when neither --jwks-file nor --jwks-json given
  const jwksUri = resolveJwksUri(args, jwks, 'create');
  const signingAlgs = parseSigningAlgs(args);
  if (signingAlgs != null && jwks == null && jwksUri == null) {
    throw new Error('create: --signing-alg needs a key set (--jwks-file, --jwks-json or --jwks-uri)');
  }
  const lifetimes = definedOnly(lifetimeFieldsFromFlags(args, 'create'));
  const logoUri = await logoUriFromFlags(args, 'create');
  const regions = await regionsFromFlags(args, 'create');

  await persistClient(platform, {
    clientId,
    redirectUris: args.flags['redirect-uri'],
    scope: scopeTokens(args.flags.scope ?? []),
    // The client name is stored in the replicated row and shown on the
    // consent screen. Defaulting it to the username would put back exactly
    // what an opaque client_id was chosen to keep out, so with one the id is
    // the better default; an operator naming the app passes --name.
    clientName: args.flagsScalar['name'] ?? (givenId != null ? clientId : username),
    clientUri: args.flagsScalar['client-uri'],
    logoUri: logoUri ?? undefined,
    ...(regions != null && regions.length > 0 ? { regions } : {}),
    grantTypes,
    applicationType: args.flagsScalar['application-type'] === 'native' ? 'native' : 'web',
    accountUserId,
    cmcOffers: parseCmcOffers(args.flags['cmc-offer']),
    ...(jwks != null ? { jwks } : {}),
    ...(jwksUri != null ? { jwksUri } : {}),
    ...(signingAlgs != null && signingAlgs.length > 0 ? { tokenEndpointAuthSigningAlgs: signingAlgs } : {}),
    ...lifetimes,
  });

  console.log('OK   client created: ' + clientId);
  if (givenId == null) {
    console.log('     note: client_id is the account username, so it is stored in the platform');
    console.log('           and sent on the wire. Use --client-id <opaque-id> to avoid that.');
  } else if (args.flagsScalar['name'] == null) {
    console.log('     note: client_name defaults to the client_id (--name sets what the');
    console.log('           consent screen shows).');
  }
  console.log('     redirect_uris: ' + args.flags['redirect-uri'].join(', '));
  console.log('     grant_types:   ' + grantTypes.join(', '));
  console.log('     account:       ' + username + ' (user id ' + accountUserId + ')');
  if (regions != null && regions.length > 0) console.log('     regions:       ' + regions.join(', '));
}

// A registry client has no app account: the operator registers it directly,
// on any core. Its scope is the MAXIMUM scope set in the grammar of the OAuth
// extension installed on the cores (customExtensions:oauthExtension).
async function runCreateRegistry (platform, args, persistClient, getClient) {
  checkFlags(args, 'create-registry', CREATE_REGISTRY_FLAGS);
  const clientId = args.positional[0];
  if (!clientId) throw new Error('create-registry: <clientId> required');
  const idError = oauthStorage().clientIdError(clientId);
  if (idError != null) throw new Error('create-registry: ' + idError);
  if (await getClient(platform, clientId) != null) {
    throw new Error('create-registry: client "' + clientId + '" already exists; revoke it first');
  }
  if (await cliEnv.localUserId(clientId) != null || await cliEnv.hostingCoreOf(clientId) != null) {
    throw new Error('create-registry: "' + clientId + '" is an account name on this platform; a client_id must not be one');
  }
  if (!args.flags['redirect-uri'] || args.flags['redirect-uri'].length === 0) {
    throw new Error('create-registry: at least one --redirect-uri is required');
  }
  if (!args.flags.scope || args.flags.scope.length === 0) {
    throw new Error('create-registry: at least one --scope is required (the maximum scope set)');
  }
  const authMethod = authMethodFlag(args, 'create-registry') ?? 'none';
  const jwks = resolveJwks(args);
  const jwksUri = resolveJwksUri(args, jwks, 'create-registry');
  if (authMethod === 'private_key_jwt' && jwks == null && jwksUri == null) {
    throw new Error('create-registry: --auth-method private_key_jwt needs --jwks-file, --jwks-json or --jwks-uri');
  }
  // A key set is a credential at /token whatever the method says: only with private_key_jwt.
  if ((jwks != null || jwksUri != null) && authMethod !== 'private_key_jwt') {
    throw new Error('create-registry: --jwks-file / --jwks-json / --jwks-uri go with --auth-method private_key_jwt (this client uses ' + authMethod + ')');
  }
  const signingAlgs = parseSigningAlgs(args);
  if (signingAlgs != null && authMethod !== 'private_key_jwt') {
    throw new Error('create-registry: --signing-alg goes with --auth-method private_key_jwt');
  }
  const lifetimes = definedOnly(lifetimeFieldsFromFlags(args, 'create-registry'));
  const fields = registryFieldsFromFlags(args, 'create-registry');
  const profile = definedOnly(profileFieldsFromFlags(args, 'create-registry'));
  const logoUri = await logoUriFromFlags(args, 'create-registry');
  const regions = await regionsFromFlags(args, 'create-registry');
  let secret = null;
  if (authMethod === 'client_secret_basic') {
    const { mintSecret } = require('oauth2/src/clientSecret.ts');
    secret = await mintSecret();
  }
  const grantTypes = (args.flags['grant-type'] && args.flags['grant-type'].length > 0)
    ? args.flags['grant-type']
    : ['authorization_code', 'refresh_token'];
  const audiences = args.flags.audience ?? [];
  const anyAudience = args.flagsScalar['any-audience'] === true;
  if (audiences.length === 0 && !anyAudience) {
    throw new Error('create-registry: at least one --audience is required, or --any-audience to register the client for any audience explicitly');
  }
  if (audiences.length > 0 && anyAudience) {
    throw new Error('create-registry: --audience and --any-audience exclude each other');
  }
  const allowInsecureRedirect = parseBooleanFlag(args, 'allow-insecure-redirect', 'create-registry') === true;
  // No default: an operator must never register a client as public by accident.
  const subjectType = args.flagsScalar['subject-type'];
  if (!SUBJECT_TYPES.includes(subjectType)) {
    throw new Error('create-registry: --subject-type public|pairwise is required (no default)' +
      (typeof subjectType === 'string' ? ', got "' + subjectType + '"' : '') + '. ' + SUBJECT_TYPES_HELP);
  }
  const allowFeatures = parseAllowFeatures(args);
  // The resource-server role: token introspection needs an authenticating client.
  const canIntrospect = parseBooleanFlag(args, 'can-introspect', 'create-registry') === true;
  if (canIntrospect && authMethod === 'none') {
    throw new Error('create-registry: --can-introspect needs a confidential client (--auth-method client_secret_basic or private_key_jwt)');
  }
  await persistClient(platform, {
    clientId,
    kind: 'registry',
    redirectUris: args.flags['redirect-uri'],
    scope: scopeTokens(args.flags.scope),
    clientName: args.flagsScalar.name ?? clientId,
    clientUri: args.flagsScalar['client-uri'],
    logoUri: logoUri ?? undefined,
    ...profile,
    ...(regions != null && regions.length > 0 ? { regions } : {}),
    policyUri: fields.policyUri,
    tosUri: fields.tosUri,
    contacts: fields.contacts ?? [],
    registeredBy: process.env.USER ?? 'operator',
    registeredAt: Date.now(),
    status: 'active',
    grantTypes,
    tokenEndpointAuthMethod: authMethod,
    allowedAudiences: audiences,
    ...(anyAudience ? { anyAudience: true } : {}),
    ...(allowInsecureRedirect ? { allowInsecureRedirect: true } : {}),
    tokenResponseExtras: fields.tokenResponseExtras ?? {},
    launchTypes: fields.launchTypes ?? [],
    subjectType,
    ...(allowFeatures != null && allowFeatures.length > 0 ? { allowFeatures } : {}),
    ...(canIntrospect ? { canIntrospect: true } : {}),
    ...(secret != null ? { clientSecretHash: secret.hash } : {}),
    ...(jwks != null ? { jwks } : {}),
    ...(jwksUri != null ? { jwksUri } : {}),
    ...(signingAlgs != null && signingAlgs.length > 0 ? { tokenEndpointAuthSigningAlgs: signingAlgs } : {}),
    ...lifetimes,
  });
  console.log('OK   registry client created: ' + clientId);
  if (canIntrospect) console.log('     introspection: allowed (resource-server role)');
  console.log('     redirect_uris: ' + args.flags['redirect-uri'].join(', '));
  console.log('     grant_types:   ' + grantTypes.join(', '));
  console.log('     auth method:   ' + authMethod);
  if (authMethod === 'private_key_jwt') {
    console.log('     keys:          ' + (jwksUri != null ? jwksUri : 'inline, ' + jwks.keys.length + ' key(s)') +
      '; algorithms: ' + (signingAlgs != null && signingAlgs.length > 0 ? signingAlgs.join(', ') : '(any that fits the keys)'));
  }
  printLifetimes(lifetimes);
  printCeilings(profile);
  if (regions != null && regions.length > 0) console.log('     regions:       ' + regions.join(', '));
  console.log('     audiences:     ' + (anyAudience ? '(any audience)' : audiences.join(', ')));
  console.log('     subject type:  ' + describeSubjectType(subjectType));
  printDefaultForbids({ allowFeatures: allowFeatures ?? [] });
  if (allowInsecureRedirect) console.log('     WARN plain-http redirect URIs allowed on non-loopback hosts');
  if (secret != null) {
    console.log('     client_secret: ' + secret.plaintext);
    console.log('     (shown once: store it now)');
  }
}

async function runSetStatus (platform, args, getClient, persistClient) {
  const clientId = args.positional[0];
  if (!clientId) throw new Error(args.command + ': <clientId> required');
  const existing = await getClient(platform, clientId);
  if (existing == null) throw new Error(args.command + ': no client "' + clientId + '"');
  const status = args.command === 'suspend' ? 'suspended' : 'active';
  const from = existing.status ?? 'active';
  // Approving a change is a decision of its own: resume does not take it.
  if (args.command === 'resume' && from === 'review') {
    throw new Error('resume: client "' + clientId + '" is under review (its redirect URIs, keys or scope changed); ' +
      'approve it with update ' + clientId + ' --approve');
  }
  // A change made while suspended goes live only once approved.
  const unapproved = args.command === 'resume' && from === 'suspended' && existing.kind === 'registry' ? unapprovedChanges(existing) : null;
  if (unapproved != null) {
    throw new Error('resume: changes to ' + (unapproved.length > 0 ? unapproved.join(', ') : 'vetted fields') + ' of "' + clientId +
      '" were not approved; approve them with update ' + clientId + ' --approve, then resume');
  }
  if (from === status) {
    console.log('OK   client ' + clientId + ' is ' + status + ' (unchanged)');
  } else {
    // Only the status changes: written as is, without the registration rules
    // (a row registered before a newer rule must stay suspendable).
    const row = withStatusChange({ ...existing, status, updatedAt: Date.now() }, { from, to: status, reason: args.command });
    await oauthStorage().setClient(platform, row);
    console.log('OK   client ' + clientId + ' is ' + status);
  }
  if (status === 'suspended') printPurgeHint(clientId);
}

// The grants of a client outlive its suspension or revocation (each is
// deleted lazily at the user's next consent): the operator's step to end them now.
function printPurgeHint (clientId) {
  console.log();
  console.log('NEXT: to end the grants, sessions and refresh chains this client holds now (each');
  console.log('      user then consents afresh), run on EACH core of the platform:');
  console.log('        node bin/oauth-client.js purge-grants ' + clientId + ' --yes');
}

/** A status change appended to the row's trail (bounded, oldest out). */
function withStatusChange (row, change) {
  const { MAX_STATUS_LOG } = require('oauth2/src/clientRegistry.ts');
  const log = [...(Array.isArray(row.statusLog) ? row.statusLog : []), { at: Date.now(), by: process.env.USER ?? 'operator', ...change }];
  return { ...row, statusLog: log.slice(-MAX_STATUS_LOG) };
}

async function runPurgeGrants (platform, args, purgeClientGrants) {
  checkFlags(args, 'purge-grants', PURGE_FLAGS);
  const clientId = args.positional[0];
  if (!clientId) throw new Error('purge-grants: <clientId> required');
  if (!isYes(args)) {
    throw new Error('purge-grants: refuses to run without --yes (it deletes every grant, session and refresh chain of "' +
      clientId + '" on this core; each user must consent again)');
  }
  const counts = await purgeClientGrants(clientId);
  console.log('OK   purged on this core: ' + clientId);
  console.log('     grants deleted:        ' + counts.grants);
  console.log('     sessions deleted:      ' + counts.sessions);
  console.log('     accesses deleted:      ' + counts.accesses + ' (grants, sessions and what they created)');
  console.log('     accounts concerned:    ' + counts.accounts);
  // The chains of the deleted sessions end with them; these had no session left.
  console.log('     other refresh tokens ended:  ' + counts.refreshTokens);
  console.log();
  console.log('NOTE: this core only; run it on every core of the platform. A CMC data-grant');
  console.log('      (app-account client) is kept: its sessions and refresh chains are ended.');
}

const PURGE_FLAGS = { values: [], booleans: ['yes'], own: [] };

async function runShow (platform, args, getClient, computeThumbprint) {
  const clientId = args.positional[0];
  if (!clientId) throw new Error('show: <clientId> required');
  const client = await getClient(platform, clientId);
  if (!client) {
    console.error('NOT FOUND: ' + clientId);
    process.exit(2);
  }
  // Never print full key material for the inline JWK Set — replace it with a
  // per-key RFC 7638 thumbprint summary (kid, if any). The public coordinates
  // are not secret, but an operator wants a stable fingerprint to compare
  // against, not raw curve points.
  const view = { ...client };
  // The secret's hash is offline-guessable: say only that one is set.
  if (client.clientSecretHash != null) view.clientSecretHash = '(set)';
  if (client.previousSecretHash != null) view.previousSecretHash = '(set)';
  if (client.jwks != null && Array.isArray(client.jwks.keys)) {
    view.jwks = {
      keys: client.jwks.keys.map((k) => ({
        ...(k && k.kid != null ? { kid: k.kid } : {}),
        ...(k && typeof k.kty === 'string' ? { kty: k.kty } : {}),
        ...(k && typeof k.crv === 'string' ? { crv: k.crv } : {}),
        ...(k && typeof k.alg === 'string' ? { alg: k.alg } : {}),
        thumbprint: safeThumbprint(computeThumbprint, k),
      })),
    };
  }
  console.log(JSON.stringify(view, null, 2));
  if (typeof client.previousSecretExpiresAt === 'number') {
    console.log('previous secret: ' + (client.previousSecretExpiresAt > Date.now()
      ? 'accepted until ' + new Date(client.previousSecretExpiresAt).toISOString()
      : 'expired ' + new Date(client.previousSecretExpiresAt).toISOString() + ' (refused)'));
  }
  if (client.tokenEndpointAuthMethod === 'private_key_jwt' || client.jwks != null || client.jwksUri != null) {
    console.log('assertion algorithms: ' + (Array.isArray(client.tokenEndpointAuthSigningAlgs) && client.tokenEndpointAuthSigningAlgs.length > 0
      ? client.tokenEndpointAuthSigningAlgs.join(', ') + ' (pinned)'
      : 'any of ES256, ES384, RS384 that fits a key of the set'));
  }
  printLifetimes(client, '');
  if (client.status === 'review') {
    const last = (Array.isArray(client.statusLog) ? client.statusLog : []).filter((e) => e?.to === 'review').pop();
    let since = '';
    if (last != null) {
      since = ' since ' + new Date(last.at).toISOString();
      if (Array.isArray(last.fields)) since += ' (' + last.fields.join(', ') + ' changed)';
    }
    console.log('status: review' + since + ': refused at /authorize, the consent, /token and introspection; ' +
      'approve it with update ' + clientId + ' --approve');
  }
  if (Array.isArray(client.regions) && client.regions.length > 0) {
    console.log('regions: ' + client.regions.join(', ') + ' (refused on the cores of any other region)');
  }
  if (client.logoUri != null) {
    const { logoAllowed } = require('oauth2/src/clientRegistry.ts');
    if (!logoAllowed(client.logoUri, await cliEnv.logoHosts())) {
      console.log('logoUri: not served (not an https URL on a host of oauth.logoHosts)');
    }
  }
  if (client.kind === 'registry') {
    printCeilings(client, '');
    if (client.subjectType == null) {
      console.log('subjectType: unset, reads as public (set it with update --subject-type)');
    }
    printDefaultForbids(client, '');
  }
  // Derived, not stored: the row carries the account's user id only.
  if (typeof client.accountUserId === 'string' && client.accountUserId.length > 0) {
    const name = await localUsername(client.accountUserId);
    console.log('account username (resolved on this core): ' +
      (name ?? '(account hosted on another core, or deleted)'));
  } else if (oauthStorage().legacyAccountUsername(client) != null) {
    console.log('LEGACY: the row still carries accountUsername; the master boot of the account\'s');
    console.log('        home core converts it to accountUserId (or run `update` on that core).');
  }
}

// Compute a key's RFC 7638 thumbprint for display; never throw out of `show`.
function safeThumbprint (computeThumbprint, jwk) {
  let key;
  try {
    key = require('oauth2/src/jwks.ts').validatePublicJwk(jwk);
  } catch (_e) {
    return '(unrecognized key)';
  }
  try {
    return computeThumbprint(key);
  } catch (_e) {
    return '(thumbprint error)';
  }
}

// One line per client: `<clientId>  <kind>  <status>  <subjectType|->`, so
// `list | grep public` is the audit of the public registry clients.
async function runList (platform, getClient) {
  const ids = await oauthStorage().listClientIds(platform);
  if (ids.length === 0) {
    console.log('(no clients registered)');
    return;
  }
  for (const id of ids) {
    const c = await getClient(platform, id);
    if (c == null) continue;
    const kind = c.kind ?? 'app-account';
    const subject = kind === 'registry' ? (c.subjectType ?? '-') : '-';
    console.log(id + '  ' + kind + '  ' + (c.status ?? 'active') + '  ' + subject);
  }
}

const SUBJECT_TYPES = ['public', 'pairwise'];
const SUBJECT_TYPES_HELP = 'public: the subject is the user\'s stable id, an alias only when the app asks for a ' +
  'pseudonym. pairwise: always an alias, one per user and client.';

function describeSubjectType (subjectType) {
  return subjectType === 'pairwise' ? 'pairwise (always an alias)' : 'public (stable user id)';
}

// What the grants of a registry client may not do, unless allowed on the row.
function printDefaultForbids (client, indent = '     ') {
  const { defaultForbiddenFeatures } = require('oauth2/src/clientRegistry.ts');
  const forbidden = defaultForbiddenFeatures(client);
  console.log(indent + 'features forbidden on its grants: ' + (forbidden.length > 0 ? forbidden.join(', ') : '(none)') +
    (Array.isArray(client.allowFeatures) && client.allowFeatures.length > 0 ? ' (allowed: ' + client.allowFeatures.join(', ') + ')' : ''));
}

// `--allow-feature <name>` (repeatable): null when absent; `none` clears the list.
function parseAllowFeatures (args) {
  const values = args.flags['allow-feature'];
  if (values == null) {
    if (args.flagsScalar['allow-feature'] === true) throw new Error('--allow-feature requires a feature name');
    return null;
  }
  if (values.length === 1 && values[0] === 'none') return [];
  return [...new Set(values)];
}

// A boolean flag: bare (true), or `true` / `false`; anything else is refused.
function parseBooleanFlag (args, name, command) {
  const v = args.flagsScalar[name];
  if (v == null) return null;
  if (v === true || v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(command + ': --' + name + ' takes no value, or true / false (got "' + v + '")');
}

// The flags a command reads. `values` need a value (refused bare), `booleans`
// take none (or true / false), `own` are checked by the command itself.
// Anything else is refused: a mistyped flag must not report success.
const COMMON_VALUES = [
  'redirect-uri', 'scope', 'grant-type', 'name', 'client-uri', 'logo-uri', 'jwks-file', 'jwks-json', 'jwks-uri', 'signing-alg',
  'access-token-ttl', 'refresh-token-ttl', 'refresh-token-absolute-ttl', 'region',
];
const COMMON_BOOLEANS = ['offline-access'];
const APP_ACCOUNT_VALUES = ['application-type', 'cmc-offer'];
const REGISTRY_VALUES = [
  'audience', 'policy-uri', 'tos-uri', 'contact', 'extra', 'launch-type', 'auth-method',
  'localized-name', 'description', 'localized-description', 'software-id', 'max-entries',
];
const CREATE_FLAGS = {
  values: [...COMMON_VALUES, ...APP_ACCOUNT_VALUES],
  booleans: [...COMMON_BOOLEANS],
  own: ['client-id'],
};
const CREATE_REGISTRY_FLAGS = {
  values: [...COMMON_VALUES, ...REGISTRY_VALUES],
  booleans: [...COMMON_BOOLEANS, 'any-audience', 'allow-insecure-redirect', 'can-introspect'],
  own: ['subject-type', 'allow-feature'],
};
const UPDATE_FLAGS = {
  values: [...COMMON_VALUES, ...REGISTRY_VALUES, ...APP_ACCOUNT_VALUES],
  booleans: [...COMMON_BOOLEANS, 'any-audience', 'allow-insecure-redirect', 'yes', 'can-introspect', 'approve'],
  own: ['subject-type', 'allow-feature', 'client-id'],
};
// Flags that only mean something on a registry row.
const REGISTRY_ONLY_FLAGS = [...REGISTRY_VALUES, 'any-audience', 'allow-insecure-redirect', 'subject-type', 'allow-feature', 'approve'];

function checkFlags (args, command, known) {
  for (const name of [...Object.keys(args.flags), ...Object.keys(args.flagsScalar)]) {
    if (!known.values.includes(name) && !known.booleans.includes(name) && !known.own.includes(name)) {
      throw new Error(command + ': unknown flag --' + name);
    }
    if (known.values.includes(name) && args.flagsScalar[name] === true) {
      throw new Error(command + ': --' + name + ' requires a value');
    }
  }
}

// `--scope` values: one value may hold several space-separated tokens.
function scopeTokens (values) {
  return values.flatMap((s) => s.split(/\s+/).filter((t) => t !== ''));
}

const AUTH_METHODS = ['none', 'client_secret_basic', 'private_key_jwt'];

function authMethodFlag (args, command) {
  const method = args.flagsScalar['auth-method'];
  if (method != null && !AUTH_METHODS.includes(method)) {
    throw new Error(command + ': --auth-method must be none, client_secret_basic or private_key_jwt');
  }
  return method ?? null;
}

// `--extra key=value` values: true, false and numbers are stored as such.
function parseExtras (values, command) {
  const extras = {};
  for (const kv of values) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new Error(command + ': --extra expects key=value, got "' + kv + '"');
    const raw = kv.slice(eq + 1);
    extras[kv.slice(0, eq)] = raw === 'true' ? true : raw === 'false' ? false : (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
  }
  return extras;
}

/**
 * The descriptive registry fields given on the command line, parsed the same
 * way by create-registry and update; absent flags are left out. `none` clears
 * a field (as for --allow-feature): undefined for a URI, empty for a list.
 */
function registryFieldsFromFlags (args, command) {
  const fields = {};
  for (const [flag, key] of [['policy-uri', 'policyUri'], ['tos-uri', 'tosUri']]) {
    const v = args.flagsScalar[flag];
    if (v != null) fields[key] = v === 'none' ? undefined : v;
  }
  const isClear = (values) => values.length === 1 && values[0] === 'none';
  for (const [flag, key] of [['contact', 'contacts'], ['launch-type', 'launchTypes']]) {
    const values = args.flags[flag];
    if (values != null) fields[key] = isClear(values) ? [] : values;
  }
  if (args.flags.extra != null) {
    fields.tokenResponseExtras = isClear(args.flags.extra) ? {} : parseExtras(args.flags.extra, command);
  }
  return fields;
}

/**
 * The registry profile from the flags (create-registry and update; absent
 * flags left out, `none` maps to undefined, which clears on update):
 * localized name, description (a text, or one per language), software id,
 * entry ceiling. Shapes are checked again on write.
 */
function profileFieldsFromFlags (args, command) {
  const fields = {};
  const isClear = (values) => values.length === 1 && values[0] === 'none';
  const names = args.flags['localized-name'];
  if (names != null) fields.name = isClear(names) ? undefined : parseLocalized(names, 'localized-name', command);
  const description = args.flagsScalar.description;
  const descriptions = args.flags['localized-description'];
  if (description != null && descriptions != null) {
    throw new Error(command + ': --description and --localized-description exclude each other');
  }
  if (description != null) fields.description = description === 'none' ? undefined : description;
  if (descriptions != null) fields.description = isClear(descriptions) ? undefined : parseLocalized(descriptions, 'localized-description', command);
  const softwareId = args.flagsScalar['software-id'];
  if (softwareId != null) fields.softwareId = softwareId === 'none' ? undefined : softwareId;
  const maxEntries = args.flagsScalar['max-entries'];
  if (maxEntries != null) {
    if (maxEntries === 'none') {
      fields.maxEntries = undefined;
    } else {
      if (!/^[1-9][0-9]*$/.test(maxEntries)) throw new Error(command + ': --max-entries takes a positive number, or none');
      fields.maxEntries = Number(maxEntries);
    }
  }
  return fields;
}

// `<lang>=<text>` values → `{ <lang>: text }` (a language given twice is refused).
function parseLocalized (values, flag, command) {
  const texts = {};
  for (const v of values) {
    const eq = v.indexOf('=');
    if (eq <= 0) throw new Error(command + ': --' + flag + ' expects <language>=<text>, got "' + v + '"');
    const lang = v.slice(0, eq);
    if (Object.hasOwn(texts, lang)) throw new Error(command + ': --' + flag + ' gives "' + lang + '" twice');
    texts[lang] = v.slice(eq + 1);
  }
  return texts;
}

/**
 * `--logo-uri`: undefined when absent, null for `none` (cleared on update),
 * else the URI, which must be https on a host of `oauth.logoHosts` (the
 * consent screen shows no other logo).
 */
async function logoUriFromFlags (args, command) {
  const v = args.flagsScalar['logo-uri'];
  if (v == null) return undefined;
  if (v === 'none') return null;
  const { logoUriProblem, logoAllowed } = require('oauth2/src/clientRegistry.ts');
  const problem = logoUriProblem(v);
  if (problem != null) throw new Error(command + ': --logo-uri: ' + problem);
  const hosts = await cliEnv.logoHosts();
  if (!logoAllowed(v, hosts)) {
    throw new Error(command + ': --logo-uri: host "' + new URL(v).host + '" is not in oauth.logoHosts (' +
      (hosts.length > 0 ? hosts.join(', ') : 'empty: no logo is accepted') + ')');
  }
  return v;
}

/**
 * `--region <key>` (repeatable): null when absent, [] for `none`. A region
 * this platform's `hostings` does not declare is refused (the client would
 * be refused on every core).
 */
async function regionsFromFlags (args, command) {
  const values = args.flags.region;
  if (values == null) return null;
  if (values.length === 1 && values[0] === 'none') return [];
  const regions = [...new Set(values)];
  const known = await cliEnv.platformRegions();
  const unknown = regions.filter((r) => !known.includes(r));
  if (unknown.length > 0) {
    throw new Error(command + ': --region ' + unknown.join(', ') + ': not a region of this platform (' + known.join(', ') + ')');
  }
  return regions;
}

// The entry ceiling of a registry client (own, or the platform bound).
function printCeilings (row, indent = '     ') {
  const { MAX_SYNTH_ENTRIES } = require('oauth2/src/scopeGrammar.ts');
  console.log(indent + 'max entries:   ' + (row.maxEntries != null
    ? row.maxEntries + ' per authorization'
    : MAX_SYNTH_ENTRIES + ' per authorization (platform bound)'));
}

// A copy with object keys in sorted order and undefined members dropped (for comparison).
function sortedKeys (v) {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (v == null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => [k, sortedKeys(v[k])]));
}

function isYes (args) {
  return args.flagsScalar.yes === true || args.flagsScalar.yes === 'true';
}

async function runUpdate (platform, args, getClient, persistClient) {
  const clientId = args.positional[0];
  if (!clientId) throw new Error('update: <clientId> required');
  // Silently ignoring it would report success on a migration that did not
  // happen: the id keys the record, so it cannot be rewritten in place.
  if (args.flagsScalar['client-id'] != null) {
    throw new Error(
      'update: client_id cannot be changed; revoke this client and create it again\n' +
      'with --client-id (its existing tokens and refresh chains die with the revoke).'
    );
  }
  checkFlags(args, 'update', UPDATE_FLAGS);
  const existing = await getClient(platform, clientId);
  if (!existing) throw new Error('update: client "' + clientId + '" not found');
  for (const flag of REGISTRY_ONLY_FLAGS) {
    if ((args.flags[flag] != null || args.flagsScalar[flag] != null) && existing.kind !== 'registry') {
      throw new Error('update: --' + flag + ' applies to registry clients only');
    }
  }

  const merged = {
    ...existing,
    redirectUris: args.flags['redirect-uri'] ?? existing.redirectUris,
    scope: args.flags.scope != null ? scopeTokens(args.flags.scope) : existing.scope,
    clientName: args.flagsScalar['name'] ?? existing.clientName,
    clientUri: args.flagsScalar['client-uri'] ?? existing.clientUri,
    grantTypes: args.flags['grant-type'] ?? existing.grantTypes,
    applicationType: args.flagsScalar['application-type'] === 'native'
      ? 'native'
      : (args.flagsScalar['application-type'] === 'web' ? 'web' : existing.applicationType),
    cmcOffers: args.flags['cmc-offer'] != null
      ? parseCmcOffers(args.flags['cmc-offer'])
      : existing.cmcOffers,
  };
  const profileFields = profileFieldsFromFlags(args, 'update');
  for (const [key, value] of Object.entries({ ...registryFieldsFromFlags(args, 'update'), ...profileFields })) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  // `--logo-uri none` clears the logo.
  const logoUri = await logoUriFromFlags(args, 'update');
  if (logoUri === null) delete merged.logoUri;
  else if (logoUri !== undefined) merged.logoUri = logoUri;
  const regions = await regionsFromFlags(args, 'update');
  if (regions != null) {
    if (regions.length > 0) merged.regions = regions;
    else delete merged.regions;
  }
  // The subject type: a legacy registry row without one is repaired on its
  // first update; changing the mode a client's grants see needs --yes.
  let subjectNote = null;
  const wantedSubject = args.flagsScalar['subject-type'];
  if (existing.kind === 'registry') {
    if (wantedSubject == null && existing.subjectType == null) {
      throw new Error('update: this client has no subject type; pass --subject-type public|pairwise');
    }
    if (wantedSubject != null) {
      if (!SUBJECT_TYPES.includes(wantedSubject)) {
        throw new Error('update: --subject-type must be public or pairwise' +
          (typeof wantedSubject === 'string' ? ', got "' + wantedSubject + '"' : ''));
      }
      // A row without a subject type reads as public.
      const effective = existing.subjectType ?? 'public';
      if (wantedSubject !== effective && !isYes(args)) {
        throw new Error('update: changing the subject type of "' + clientId + '" from ' + effective + ' to ' +
          wantedSubject + ' affects every future consent; re-run with --yes');
      }
      merged.subjectType = wantedSubject;
      if (wantedSubject !== effective) subjectNote = { from: effective, to: wantedSubject };
    }
  }
  if (args.flags.audience != null) {
    merged.allowedAudiences = args.flags.audience;
    delete merged.anyAudience;
  }
  if (args.flagsScalar['any-audience'] != null) {
    if (args.flags.audience != null) throw new Error('update: --audience and --any-audience exclude each other');
    if (parseBooleanFlag(args, 'any-audience', 'update') === true) {
      merged.anyAudience = true;
      merged.allowedAudiences = [];
    } else {
      delete merged.anyAudience;
    }
  }
  if (args.flagsScalar['allow-insecure-redirect'] != null) {
    // `--allow-insecure-redirect false` withdraws the permission.
    if (parseBooleanFlag(args, 'allow-insecure-redirect', 'update') === true) merged.allowInsecureRedirect = true;
    else delete merged.allowInsecureRedirect;
  }
  const allowFeatures = parseAllowFeatures(args);
  if (allowFeatures != null) {
    if (allowFeatures.length > 0) merged.allowFeatures = allowFeatures;
    else delete merged.allowFeatures;
  }
  // Not read any more: apiEndpoint follows the grant (sent unless aliased).
  delete merged.omitApiEndpoint;
  // Replace the key set only when --jwks-file / --jwks-json / --jwks-uri is
  // given (inline and by reference exclude each other); otherwise keep it.
  const jwks = resolveJwks(args);
  const jwksUri = resolveJwksUri(args, jwks, 'update');
  if (jwks != null) {
    merged.jwks = jwks;
    delete merged.jwksUri;
  }
  if (jwksUri != null) {
    merged.jwksUri = jwksUri;
    delete merged.jwks;
  }
  const signingAlgs = parseSigningAlgs(args);
  if (signingAlgs != null) {
    if (signingAlgs.length > 0) merged.tokenEndpointAuthSigningAlgs = signingAlgs;
    else delete merged.tokenEndpointAuthSigningAlgs;
  }
  const lifetimeFields = lifetimeFieldsFromFlags(args, 'update');
  for (const [key, value] of Object.entries(lifetimeFields)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const secret = existing.kind === 'registry'
    ? await updateAuthMethod(existing, merged, args, jwks != null || jwksUri != null, signingAlgs != null && signingAlgs.length > 0)
    : null;
  // `--can-introspect` (bare / true / false): the resource-server role.
  const canIntrospect = parseBooleanFlag(args, 'can-introspect', 'update');
  if (canIntrospect === true) {
    const confidential = (typeof merged.clientSecretHash === 'string' && merged.clientSecretHash.length > 0) || hasKeys(merged);
    if (!confidential) throw new Error('update: --can-introspect needs a confidential client (a secret or a key set on file)');
    merged.canIntrospect = true;
  } else if (canIntrospect === false) {
    delete merged.canIntrospect;
  }
  // A row written before accountUserId: convert it when the account is on this
  // core (same operation as the master-boot migration), so this whole-row write
  // does not re-install the old field after the boot converted it.
  const row = (await oauthStorage().convertClientAccount(merged, localUserId)) ?? merged;
  // The vetting: a change of what the client was vetted on puts it under review.
  const vetting = vettingChange(existing, row, args);
  if (vetting != null && vetting.to !== (existing.status ?? 'active')) row.status = vetting.to;
  // Nothing changed (e.g. the same --subject-type again): no write, so the
  // row's version (and every consent in flight for it) stays as it is.
  const { updatedAt: _before, ...existingRest } = existing;
  const { updatedAt: _after, ...rowRest } = row;
  if (vetting?.entry == null && JSON.stringify(sortedKeys(existingRest)) === JSON.stringify(sortedKeys(rowRest))) {
    console.log('OK   client unchanged: ' + clientId);
    return;
  }
  await persistClient(platform, vetting?.entry != null ? withStatusChange(row, vetting.entry) : row);
  console.log('OK   client updated: ' + clientId);
  if (vetting?.entry != null) printVetting(clientId, vetting);
  if (row !== merged) console.log('     converted the account reference to the user id');
  if (existing.kind === 'registry' && wantedSubject != null) {
    console.log('     subject type:  ' + describeSubjectType(merged.subjectType));
  }
  if (row.tokenEndpointAuthMethod !== existing.tokenEndpointAuthMethod) {
    console.log('     auth method:   ' + row.tokenEndpointAuthMethod + ' (was ' + (existing.tokenEndpointAuthMethod ?? '(unset)') + ')');
  }
  // Introspection refuses a public caller at run time; say so rather than
  // leave a role that silently does nothing.
  if (row.canIntrospect === true && !(typeof row.clientSecretHash === 'string' && row.clientSecretHash.length > 0) && !hasKeys(row)) {
    console.log('     WARN introspection role kept on a public client: refused until it has a secret or a key set ' +
      '(--can-introspect false withdraws it)');
  }
  // The flags that widen what the client may do, echoed as create-registry does.
  if (args.flags.audience != null || args.flagsScalar['any-audience'] != null) {
    console.log('     audiences:     ' + (row.anyAudience === true ? '(any audience)' : (row.allowedAudiences ?? []).join(', ')));
  }
  if (args.flagsScalar['allow-insecure-redirect'] != null) {
    console.log(row.allowInsecureRedirect === true
      ? '     WARN plain-http redirect URIs allowed on non-loopback hosts'
      : '     plain-http redirect URIs refused on non-loopback hosts');
  }
  if (args.flags['allow-feature'] != null) printDefaultForbids(row);
  if (Object.keys(lifetimeFields).length > 0) printLifetimes(row);
  if (Object.hasOwn(profileFields, 'maxEntries')) printCeilings(row);
  if (regions != null) console.log('     regions:       ' + (regions.length > 0 ? regions.join(', ') : '(every region)'));
  if (secret != null) {
    console.log('     client_secret: ' + secret.plaintext);
    console.log('     (shown once: store it now)');
  }
  if (subjectNote != null) {
    console.log();
    console.log('NOTE: existing grants keep their current subject and their sessions keep');
    console.log('      working; each user sees the change of identity mode, and must');
    console.log('      acknowledge it, at their next consent (' + subjectNote.from + ' to ' + subjectNote.to + ').');
  }
}

/**
 * The vetting outcome of an update of a registry client, or null (other
 * kinds). A change of a vetted field (`VETTED_FIELDS`: where its codes and
 * tokens land, how it authenticates, what it reaches, for how long) moves an
 * active client to `review` (refused everywhere until approved) unless the
 * operator approves it in the same command (`--approve`); `--approve` alone
 * approves a client under review. A suspended client stays suspended: its
 * trail records the change, which `resume` refuses until `--approve`
 * approves it (the client staying suspended). Each such change is an entry
 * of the row's status trail.
 */
function vettingChange (existing, row, args) {
  if (existing.kind !== 'registry') return null;
  const { changedVettedFields } = require('oauth2/src/clientRegistry.ts');
  const approve = parseBooleanFlag(args, 'approve', 'update') === true;
  const fields = changedVettedFields(existing, row);
  const from = existing.status ?? 'active';
  const withFields = fields.length > 0 ? { fields } : {};
  if (approve) {
    // A suspended client stays suspended: the approval covers the changes
    // recorded meanwhile, so that `resume` may put it back.
    if (from === 'suspended') {
      if (fields.length === 0 && unapprovedChanges(existing) == null) return { to: from, entry: null };
      return { to: from, entry: { from, to: from, reason: 'approve', ...withFields } };
    }
    if (from === 'active' && fields.length === 0) return { to: from, entry: null };
    return { to: 'active', entry: { from, to: 'active', reason: 'approve', ...withFields } };
  }
  if (fields.length === 0) return { to: from, entry: null };
  const to = from === 'active' ? 'review' : from;
  return { to, entry: { from, to, reason: 'review', ...withFields } };
}

/**
 * The vetted fields changed and not approved since (the `review` entries of
 * the trail after its last `approve`), or null when there are none.
 */
function unapprovedChanges (row) {
  const log = Array.isArray(row.statusLog) ? row.statusLog : [];
  const lastApprove = log.findLastIndex((e) => e?.reason === 'approve');
  const pending = log.slice(lastApprove + 1).filter((e) => e?.reason === 'review');
  if (pending.length === 0) return null;
  return [...new Set(pending.flatMap((e) => (Array.isArray(e.fields) ? e.fields : [])))];
}

function printVetting (clientId, vetting) {
  const fields = vetting.entry.fields ?? [];
  const what = fields.length > 0 ? fields.join(', ') + ' changed' : 'no change';
  if (vetting.entry.reason === 'approve') {
    console.log('     status:        ' + vetting.to + ' (approved; ' + what + ')' + (vetting.to === 'suspended' ? ': resume it to put it back in service' : ''));
  } else if (vetting.to === 'review') {
    console.log('     status:        review (' + what + '): /authorize, the consent, /token and introspection');
    console.log('                    refuse this client until approved: update ' + clientId + ' --approve');
  } else {
    console.log('     status:        ' + vetting.to + ' (' + what + '; recorded' + (vetting.to === 'suspended' ? ': approve it with update ' + clientId + ' --approve before resume' : '') + ')');
  }
}

/**
 * `update --auth-method` on a registry row: the credentials on file follow the
 * method (authentication at /token keys on them), so a change drops the ones
 * of the old method. A new client_secret_basic mints a secret (returned, to be
 * printed once); a move to none needs --yes. Mutates `merged`.
 */
async function updateAuthMethod (existing, merged, args, keysGiven, algsGiven) {
  const from = existing.tokenEndpointAuthMethod ?? '(unset)';
  const to = authMethodFlag(args, 'update') ?? from;
  if (keysGiven && to !== 'private_key_jwt') {
    throw new Error('update: --jwks-file / --jwks-json / --jwks-uri go with --auth-method private_key_jwt (this client uses ' + to + ')');
  }
  if (algsGiven && to !== 'private_key_jwt') {
    throw new Error('update: --signing-alg goes with --auth-method private_key_jwt (this client uses ' + to + ')');
  }
  if (to === from) return null;
  merged.tokenEndpointAuthMethod = to;
  if (to === 'none') {
    if (!isYes(args)) {
      throw new Error('update: changing the client authentication of "' + existing.clientId + '" from ' + from +
        ' to none makes it a public client (its refresh tokens are then redeemed without client authentication); re-run with --yes');
    }
    dropSecrets(merged);
    dropKeys(merged);
    return null;
  }
  if (to === 'private_key_jwt') {
    if (merged.jwks == null && merged.jwksUri == null) {
      throw new Error('update: --auth-method private_key_jwt needs --jwks-file, --jwks-json or --jwks-uri');
    }
    dropSecrets(merged);
    return null;
  }
  const { mintSecret } = require('oauth2/src/clientSecret.ts');
  const secret = await mintSecret();
  dropSecrets(merged);
  merged.clientSecretHash = secret.hash;
  dropKeys(merged);
  return secret;
}

// The credentials of one method, dropped when the client moves to another.
function dropSecrets (row) {
  delete row.clientSecretHash;
  delete row.previousSecretHash;
  delete row.previousSecretExpiresAt;
}

function dropKeys (row) {
  delete row.jwks;
  delete row.jwksUri;
  delete row.tokenEndpointAuthSigningAlgs;
}

// A key set on file, inline or by reference.
function hasKeys (row) {
  return (row.jwks != null && Array.isArray(row.jwks.keys) && row.jwks.keys.length > 0) ||
    (typeof row.jwksUri === 'string' && row.jwksUri.length > 0);
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
  console.log('NOTE: the client row is removed (no new grants, refresh dies) AND a');
  console.log('      cluster-wide revoke tombstone is written. Every core stops the');
  console.log('      app\'s LIVE access tokens within oauth.clientRevokeCheckSeconds');
  console.log('      (default 30s) — read locally from PlatformDB, no cross-core bus.');
  console.log('      Re-registering the same client id does NOT clear the tombstone:');
  console.log('      tokens minted before the revoke stay dead, tokens of the new');
  console.log('      registration are honoured.');
  printPurgeHint(clientId);
}

// --- Operator revoke-by-DPoP-key (RFC 9449 sender-constrained tokens) --- //
//
// Revokes a specific key thumbprint (jkt), not a whole client: use it to kill a
// single leaked device/session key. Presence (blocklist) semantics — every
// token bound to the key dies regardless of when it was minted, and the key can
// neither mint nor rotate new tokens.

async function runRevokeKey (platform, args, revokeDpopKey) {
  const jkt = args.positional[0];
  if (!jkt) throw new Error('revoke-key: <jkt> required (the RFC 7638 thumbprint of the key)');
  if (!args.flags['yes'] && !args.flagsScalar['yes']) {
    throw new Error('revoke-key: refuses to run without --yes (operator-revoke is a footgun)');
  }
  await revokeDpopKey(platform, jkt); // throws on a malformed (non-43-char-base64url) jkt
  console.log('OK   DPoP key revoked: ' + jkt);
  console.log();
  console.log('NOTE: a cluster-wide revoke tombstone is written. Every core stops');
  console.log('      LIVE DPoP-bound tokens on this key within');
  console.log('      oauth.dpop.keyRevokeCheckSeconds (default 30s) — read locally');
  console.log('      from PlatformDB, no cross-core bus. The key can neither mint');
  console.log('      nor rotate new tokens. Reverse with:');
  console.log('        node bin/oauth-client.js unrevoke-key ' + jkt + ' --yes');
}

async function runUnrevokeKey (platform, args, unrevokeDpopKey) {
  const jkt = args.positional[0];
  if (!jkt) throw new Error('unrevoke-key: <jkt> required');
  if (!args.flags['yes'] && !args.flagsScalar['yes']) {
    throw new Error('unrevoke-key: refuses to run without --yes');
  }
  await unrevokeDpopKey(platform, jkt); // throws on a malformed jkt
  console.log('OK   DPoP key un-revoked: ' + jkt);
  console.log('     Pre-expiry tokens bound to this key resume within the cache TTL.');
}

async function runListRevokedKeys (platform, listRevokedDpopKeys) {
  const list = await listRevokedDpopKeys(platform);
  if (list.length === 0) { console.log('(no revoked DPoP keys)'); return; }
  list.sort((a, b) => b.revokedAt - a.revokedAt);
  for (const { jkt, revokedAt } of list) {
    console.log(jkt + '  revoked ' + new Date(revokedAt).toISOString());
  }
}

// Operator pick-list: every DPoP key thumbprint seen bound for a client, most
// recently used first, flagged REVOKED where a tombstone exists. Advisory data
// (the seen-inventory) joined with authoritative revoke tombstones.
async function runListKeys (platform, args, listDpopKeysSeen, listRevokedDpopKeys) {
  const clientId = args.positional[0]; // optional filter
  const seen = await listDpopKeysSeen(platform, clientId);
  if (seen.length === 0) {
    console.log(clientId ? '(no DPoP keys seen for ' + clientId + ')' : '(no DPoP keys seen)');
    return;
  }
  const revoked = new Set((await listRevokedDpopKeys(platform)).map((e) => e.jkt));
  seen.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  for (const { clientId: cid, jkt, firstSeenAt, lastSeenAt } of seen) {
    console.log(
      jkt +
      '  ' + cid +
      '  first=' + new Date(firstSeenAt).toISOString() +
      '  last=' + new Date(lastSeenAt).toISOString() +
      (revoked.has(jkt) ? '  REVOKED' : '')
    );
  }
}

async function runRotateSecret (platform, args, getClient, persistClient) {
  const clientId = args.positional[0];
  if (!clientId) throw new Error('rotate-secret: <clientId> required');
  if (args.flagsScalar['client-id'] != null) {
    throw new Error('rotate-secret: client_id cannot be changed here; name the client as the argument');
  }
  checkFlags(args, 'rotate-secret', ROTATE_SECRET_FLAGS);
  const windowSeconds = parsePreviousValidFor(args);
  const existing = await getClient(platform, clientId);
  if (!existing) throw new Error('rotate-secret: client "' + clientId + '" not found');
  // A secret on such a client would make it confidential by a method it is
  // not registered for (authentication at /token keys on the credentials on file).
  const method = existing.tokenEndpointAuthMethod;
  if (method === 'none' || method === 'private_key_jwt') {
    throw new Error('rotate-secret: client "' + clientId + '" authenticates with ' + method + ', which uses no secret; ' +
      'to switch it to a secret, run update ' + clientId + ' --auth-method client_secret_basic');
  }

  const { mintSecret } = require('oauth2/src/clientSecret.ts');
  const { plaintext, hash } = await mintSecret();

  // The secret replaced stays valid for the window asked (none by default:
  // a rotation after a leak must end the old secret at once). A second
  // rotation within a window ends the older secret.
  const row = { ...existing, clientSecretHash: hash };
  delete row.previousSecretHash;
  delete row.previousSecretExpiresAt;
  const keepPrevious = windowSeconds > 0 && typeof existing.clientSecretHash === 'string' && existing.clientSecretHash.length > 0;
  if (keepPrevious) {
    row.previousSecretHash = existing.clientSecretHash;
    row.previousSecretExpiresAt = Date.now() + windowSeconds * 1000;
  }
  await persistClient(platform, row);

  console.log('OK   client_secret rotated for: ' + clientId);
  console.log();
  console.log('client_id:     ' + clientId);
  console.log('client_secret: ' + plaintext);
  console.log();
  console.log('SHOWN ONCE. Store it now in the consuming app. The hash is');
  console.log('persisted; the plaintext is never written to disk or logs.');
  if (keepPrevious) {
    console.log('The previous secret is still accepted until ' + new Date(row.previousSecretExpiresAt).toISOString() +
      ' (then refused).');
  } else {
    console.log('The previous secret is refused from now on. Re-run with --previous-valid-for <seconds>');
    console.log('to keep the replaced secret valid while the app switches (30 days at most).');
  }
}

const ROTATE_SECRET_FLAGS = { values: ['previous-valid-for'], booleans: [], own: [] };

// `--previous-valid-for <seconds>`: 0 (the default) to 30 days.
function parsePreviousValidFor (args) {
  const v = args.flagsScalar['previous-valid-for'];
  if (v == null) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error('rotate-secret: --previous-valid-for takes a number of seconds');
  const seconds = Number(v);
  if (seconds > 30 * 24 * 3600) throw new Error('rotate-secret: --previous-valid-for is 30 days (2592000 seconds) at most');
  return seconds;
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

// --jwks-file <path> | --jwks-json <json> → the inline public JWK Set object,
// or undefined when neither is given. Mutually exclusive. Only parses JSON here;
// deep validation (EC P-256 / P-384 or RSA public keys, no private member, a kid
// on each key of a set of several) happens in persistClient → validatePublicJwkSet.
function resolveJwks (args) {
  const file = args.flagsScalar['jwks-file'];
  const json = args.flagsScalar['jwks-json'];
  const hasFile = typeof file === 'string' && file.length > 0;
  const hasJson = typeof json === 'string' && json.length > 0;
  if (hasFile && hasJson) {
    throw new Error('--jwks-file and --jwks-json are mutually exclusive');
  }
  if (!hasFile && !hasJson) return undefined;
  let raw;
  if (hasFile) {
    const fs = require('fs');
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error('--jwks-file: cannot read "' + file + '": ' + (err.message ?? err));
    }
  } else {
    raw = json;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('--jwks-' + (hasFile ? 'file' : 'json') + ': not valid JSON: ' + (err.message ?? err));
  }
}

// --jwks-uri <https-url> → the key set by reference, or undefined. Excludes an
// inline set given in the same command. Deep checks in persistClient.
function resolveJwksUri (args, jwks, command) {
  const uri = args.flagsScalar['jwks-uri'];
  if (uri == null) return undefined;
  if (jwks != null) throw new Error(command + ': --jwks-uri excludes --jwks-file / --jwks-json');
  return uri;
}

// --signing-alg <alg> (multi) → the pinned algorithms, null when absent, []
// for "none" (clears the list on update).
function parseSigningAlgs (args) {
  const values = args.flags['signing-alg'];
  if (values == null) return null;
  if (values.length === 1 && values[0] === 'none') return [];
  const { CLIENT_ASSERTION_ALGS } = require('oauth2/src/jwks.ts');
  const unknown = values.filter((a) => !CLIENT_ASSERTION_ALGS.includes(a));
  if (unknown.length > 0) {
    throw new Error('--signing-alg must be one of ' + CLIENT_ASSERTION_ALGS.join(', ') + ' (got ' + unknown.join(', ') + ')');
  }
  return [...new Set(values)];
}

const LIFETIME_FLAGS = [
  ['access-token-ttl', 'accessTokenTTL'],
  ['refresh-token-ttl', 'refreshTokenTTL'],
  ['refresh-token-absolute-ttl', 'refreshTokenAbsoluteTTL'],
];

// The client's lifetimes and offline access from the flags: an absent flag is
// left out, `none` (or `--offline-access true`, the default) maps to
// undefined (the field is removed on update).
function lifetimeFieldsFromFlags (args, command) {
  const fields = {};
  for (const [flag, key] of LIFETIME_FLAGS) {
    const v = args.flagsScalar[flag];
    if (v == null) continue;
    if (v === 'none') {
      fields[key] = undefined;
      continue;
    }
    if (!/^[1-9][0-9]*$/.test(v)) throw new Error(command + ': --' + flag + ' takes a positive number of seconds, or none');
    fields[key] = Number(v);
  }
  const offline = parseBooleanFlag(args, 'offline-access', command);
  if (offline != null) fields.offlineAccessAllowed = offline ? undefined : false;
  return fields;
}

function definedOnly (fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

// The lifetimes a client row carries (each is clamped at use to the platform's).
function printLifetimes (row, indent = '     ') {
  const own = LIFETIME_FLAGS.filter(([, key]) => row[key] != null).map(([flag, key]) => flag.replace(/-/g, ' ') + ' ' + row[key] + ' s');
  if (own.length > 0) console.log(indent + 'lifetimes:     ' + own.join(', ') + ' (each capped by this platform\'s oauth settings)');
  if (row.offlineAccessAllowed === false) console.log(indent + 'offline access: withheld (no refresh token)');
}

// The oauth2 storage helpers (client row shape), loaded after boiler init.
function oauthStorage () {
  return require('../components/oauth2/src/storage.ts');
}

// User id of a username (or alias) on THIS core's local index, or null.
async function localUserId (username) {
  const { getUsersLocalIndex } = require('storage');
  const usersIndex = await getUsersLocalIndex();
  return (await usersIndex.getUserId(username)) ?? null;
}

// Canonical username of a user id on THIS core's local index, or null.
async function localUsername (userId) {
  const { getUsersLocalIndex } = require('storage');
  const usersIndex = await getUsersLocalIndex();
  return (await usersIndex.getUsername(userId)) ?? null;
}

// On a multi-core platform, the id of the core hosting `username`; null when
// single-core or unknown. Only called once the local lookup failed; the
// platform (which registers this core at init) is only loaded on multi-core.
async function hostingCoreOf (username) {
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();
  if (config.get('core:isSingleCore') !== false) return null;
  try {
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    return (await platform.getUserCore(username)) ?? null;
  } catch (err) {
    console.error('WARN: could not ask the platform where "' + username + '" is hosted: ' + (err.message ?? err));
    return null;
  }
}

function parseArgs (argv) {
  // Declared here, not at module level: parseArgs runs from the async block
  // at the top of the file, before module-level constants are initialized.
  const MULTI_FLAGS = ['redirect-uri', 'scope', 'grant-type', 'cmc-offer', 'audience', 'contact', 'extra', 'launch-type', 'allow-feature', 'signing-alg',
    'region', 'localized-name', 'localized-description'];
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
        if (MULTI_FLAGS.includes(key)) {
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
    'OAuth2 client management CLI (app-account and registry clients)\n\n' +
    'Usage:\n' +
    '  node bin/oauth-client.js create <username> [--client-id <opaque-id>] --redirect-uri <uri> [more flags]\n' +
    '  node bin/oauth-client.js show <clientId>\n' +
    '  node bin/oauth-client.js list\n' +
    '  node bin/oauth-client.js update <clientId> [flags]\n' +
    '  node bin/oauth-client.js revoke <clientId> --yes\n' +
    '  node bin/oauth-client.js revoke-key <jkt> --yes\n' +
    '  node bin/oauth-client.js unrevoke-key <jkt> --yes\n' +
    '  node bin/oauth-client.js list-revoked-keys\n' +
    '  node bin/oauth-client.js list-keys [<clientId>]\n' +
    '  node bin/oauth-client.js rotate-secret <clientId> [--previous-valid-for <seconds>]\n' +
    '  node bin/oauth-client.js create-registry <clientId> --redirect-uri <uri> --scope <s> --subject-type public|pairwise\n' +
    '      (--audience <url> | --any-audience) [flags]\n' +
    '  node bin/oauth-client.js suspend|resume <clientId>\n' +
    '  node bin/oauth-client.js purge-grants <clientId> --yes\n\n' +
    'Status: active, suspended (suspend / resume) or review. On update, a change of\n' +
    'a registry client\'s --redirect-uri, --scope or key set (--jwks-file, --jwks-json,\n' +
    '--jwks-uri, or an --auth-method change that drops it) moves an active client to\n' +
    'review, unless --approve is given; "update <id> --approve" approves a client\n' +
    'under review. A client suspended or under review is refused at /authorize, the\n' +
    'consent, /token and introspection. Every change is kept in its statusLog.\n' +
    'purge-grants deletes, on THIS core, every grant of the client with its sessions,\n' +
    'what they created, their aliases and refresh chains (each user consents again);\n' +
    'run it on each core, e.g. after revoke or suspend.\n\n' +
    'Flags (create-registry; on update too, registry clients only): a client with\n' +
    'no app account; --scope is its maximum scope set in the grammar of the\n' +
    'installed OAuth extension. On update, a repeatable flag replaces the stored\n' +
    'list, and "none" clears --extra, --contact, --launch-type, --policy-uri and\n' +
    '--tos-uri. An unknown flag is refused.\n' +
    '  --auth-method none|client_secret_basic|private_key_jwt   (default none;\n' +
    '                            --jwks-file / --jwks-json / --jwks-uri and --signing-alg\n' +
    '                            go with private_key_jwt only; the\n' +
    '                            secret is printed once; on update, a change drops the\n' +
    '                            credentials of the old method, a new secret is minted\n' +
    '                            for client_secret_basic, and none needs --yes)\n' +
    '  --audience <url>          (multi; also on update) resource values the client may\n' +
    '                            request (aud or resource; else invalid_target); at least\n' +
    '                            one, unless --any-audience\n' +
    '  --any-audience            (also on update) register the client explicitly for any\n' +
    '                            audience (no list check: a well-formed aud / resource is\n' +
    '                            stored and answered as introspection aud)\n' +
    '  --allow-insecure-redirect (also on update; "false" withdraws it) accept plain-http\n' +
    '                            redirect URIs on a non-loopback host (refused otherwise;\n' +
    '                            reported at every core boot)\n' +
    '  --extra <key>=<value>     (multi) static extra field of every token response\n' +
    '  --launch-type <s>         (multi)   --contact <s> (multi)\n' +
    '  --policy-uri <uri>  --tos-uri <uri>\n' +
    '  --subject-type public|pairwise   REQUIRED (no default; also on update, where a\n' +
    '                            change needs --yes) the subject the app sees: public,\n' +
    '                            the user\'s stable id (an alias only when the app asks\n' +
    '                            for a pseudonym); pairwise, always an alias, one per\n' +
    '                            user and client; an aliased session is used at its\n' +
    '                            alias only\n' +
    '  --allow-feature <name>    (multi; also on update, "none" clears) a feature its\n' +
    '                            grants may use: webhooks, secretSharing, accessCreation\n' +
    '                            (each forbidden on its grants otherwise)\n' +
    '  --can-introspect          (also on update, any client; "false" withdraws it) the\n' +
    '                            resource-server role: may call /oauth2/introspect.\n' +
    '                            Confidential clients only (a secret or a key set)\n' +
    '  --localized-name <lang>=<text>   (multi; "none" clears) the name per language\n' +
    '                            (--name stays the plain fallback); shown on the\n' +
    '                            consent screen, before sign-in too\n' +
    '  --description <text> | --localized-description <lang>=<text> (multi)\n' +
    '                            what the app does, one text or one per language\n' +
    '                            ("none" clears)\n' +
    '  --software-id <s>         the software this registration is of (RFC 7591)\n' +
    '  --max-entries <n>         ceiling on the permission entries one authorization\n' +
    '                            may request (default and maximum: 1000)\n' +
    '  --approve                 (update only) approve the change made in the same\n' +
    '                            command, or a client under review\n\n' +
    'Flags (create / update):\n' +
    '  --client-id <opaque-id>   (create only) the client_id to register, instead of\n' +
    '                            the account username. 4-64 chars of A-Z a-z 0-9 . ~ -\n' +
    '                            Use it where the username must not reach the platform\n' +
    '                            store or the wire (hashed-PII deployments)\n' +
    '  --redirect-uri <uri>      (multi-valued; at least one required on create)\n' +
    '  --scope <scope-token>     (multi-valued; space-separated tokens in one value are\n' +
    '                            split; e.g. cmc:<offer-name>, paired with --cmc-offer)\n' +
    '  --grant-type <name>       (multi-valued; default authorization_code,refresh_token)\n' +
    '  --name <human-name>       client_name shown on the consent screen\n' +
    '  --client-uri <uri>        client_uri shown on the consent screen\n' +
    '  --logo-uri <uri>          logo_uri shown on the consent screen: https, on a host\n' +
    '                            listed in oauth.logoHosts ("none" clears on update)\n' +
    '  --region <key>            (multi; "none" clears on update) the regions of this\n' +
    '                            platform (hostings) whose cores serve the client;\n' +
    '                            refused on the cores of any other (default: all)\n' +
    '  --application-type web|native\n' +
    '  --jwks-file <path>        inline public JWK Set (private_key_jwt client auth):\n' +
    '                            EC P-256 (ES256), EC P-384 (ES384) or RSA of 2048 bits\n' +
    '                            or more (RS384) PUBLIC keys; a key with private members\n' +
    '                            is rejected; several keys need a distinct "kid" each\n' +
    '  --jwks-json <json>        same, as an inline JSON string (mutually exclusive\n' +
    '                            with --jwks-file)\n' +
    '  --jwks-uri <https-url>    the key set by reference instead (excludes the two\n' +
    '                            above): fetched by the core, https only, no redirect,\n' +
    '                            private addresses refused, cached 5 minutes\n' +
    '  --signing-alg <alg>       (multi; "none" clears on update) pin the algorithms\n' +
    '                            the client\'s assertions may use: ES256, ES384, RS384\n' +
    '                            (default: any that fits a key of its set)\n' +
    '  --access-token-ttl <s>  --refresh-token-ttl <s>  --refresh-token-absolute-ttl <s>\n' +
    '                            this client\'s token lifetimes in seconds ("none" clears\n' +
    '                            on update); never longer than the oauth settings of the\n' +
    '                            platform, which cap them at use\n' +
    '  --offline-access true|false   false: no refresh token is issued to or redeemed\n' +
    '                            by this client (default true)\n' +
    '  --cmc-offer <name>=<capabilityUrl>\n' +
    '                            (multi-valued) register a consent-offer reference for\n' +
    '                            granular scope: the app account publishes an open-link\n' +
    '                            consent/request-cmc offer, then registers its capability\n' +
    '                            URL here; clients request it as scope "cmc:<name>"\n' +
    '                            (add the token to --scope as well)\n\n' +
    'Notes:\n' +
    '  - create requires the user to ALREADY exist on THIS core (promotion-only;\n' +
    '    run it on the account\'s home core).\n' +
    '  - revoke requires --yes (operator footgun protection).\n' +
    '  - create, create-registry and update refuse an unknown flag.\n' +
    '  - rotate-secret is refused on a client whose auth method uses no secret\n' +
    '    (none, private_key_jwt): switch it with update --auth-method.\n' +
    '  - rotate-secret --previous-valid-for <seconds> keeps the replaced secret valid\n' +
    '    that long (30 days at most; default 0: refused at once, as after a leak).\n' +
    '  - show prints the client secret as "(set)", never its hash.\n' +
    '  - HTTP `POST /oauth2/register` (RFC 7591 mode:open) is intentionally deferred.\n'
  );
}

// The logo allow-list (`oauth.logoHosts`) and the regions of this platform
// (`hostings`; `default` when it declares none), from the config.
async function configLogoHosts () {
  const { getConfig } = require('@pryv/boiler');
  const { logoHostsFromConfig } = require('oauth2/src/clientRegistry.ts');
  return logoHostsFromConfig(await getConfig());
}

async function configRegions () {
  const { getConfig } = require('@pryv/boiler');
  const regions = (await getConfig()).get('hostings')?.regions;
  return regions != null && typeof regions === 'object' ? Object.keys(regions) : ['default'];
}

// The purge runs this core's account teardown (api-server), loaded on use.
async function purgeOnThisCore (clientId) {
  const { purgeClientGrants } = require('api-server/src/methods/helpers/oauthGrantPurge.ts');
  return await purgeClientGrants(clientId);
}

// Account-name lookups, config reads and the purge, replaceable by tests (no
// users index nor config there).
const cliEnv = {
  localUserId: (u) => localUserId(u),
  hostingCoreOf: (u) => hostingCoreOf(u),
  logoHosts: () => configLogoHosts(),
  platformRegions: () => configRegions(),
  purgeClientGrants: (clientId) => purgeOnThisCore(clientId),
};

module.exports = {
  parseArgs,
  runCreate,
  runCreateRegistry,
  runUpdate,
  runShow,
  runList,
  runSetStatus,
  runRotateSecret,
  runRevoke,
  runPurgeGrants,
  cliEnv,
};

if (require.main === module) main();
