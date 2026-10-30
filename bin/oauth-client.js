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
//   node bin/oauth-client.js create <username> [--client-id <opaque-id>] [--redirect-uri <uri>]... [--scope <s>] [--name <s>] [--logo-uri <s>] [--client-uri <s>] [--application-type web|native]
//   node bin/oauth-client.js list
//   node bin/oauth-client.js show <clientId>
//   node bin/oauth-client.js update <clientId> [--redirect-uri <uri>]... [--scope <s>] ...
//   node bin/oauth-client.js revoke <clientId>
//   node bin/oauth-client.js revoke-key <jkt> --yes
//   node bin/oauth-client.js unrevoke-key <jkt> --yes
//   node bin/oauth-client.js list-revoked-keys
//   node bin/oauth-client.js list-keys [<clientId>]

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

  await persistClient(platform, {
    clientId,
    redirectUris: args.flags['redirect-uri'],
    scope: args.flags['scope'] ?? [],
    // The client name is stored in the replicated row and shown on the
    // consent screen. Defaulting it to the username would put back exactly
    // what an opaque client_id was chosen to keep out, so with one the id is
    // the better default; an operator naming the app passes --name.
    clientName: args.flagsScalar['name'] ?? (givenId != null ? clientId : username),
    clientUri: args.flagsScalar['client-uri'],
    logoUri: args.flagsScalar['logo-uri'],
    grantTypes,
    applicationType: args.flagsScalar['application-type'] === 'native' ? 'native' : 'web',
    accountUserId,
    cmcOffers: parseCmcOffers(args.flags['cmc-offer']),
    ...(jwks != null ? { jwks } : {}),
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
}

// A registry client has no app account: the operator registers it directly,
// on any core. Its scope is the MAXIMUM scope set in the grammar of the OAuth
// extension installed on the cores (customExtensions:oauthExtension).
async function runCreateRegistry (platform, args, persistClient, getClient) {
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
  const authMethod = args.flagsScalar['auth-method'] ?? 'none';
  const jwks = resolveJwks(args);
  let secret = null;
  if (authMethod === 'client_secret_basic') {
    const { mintSecret } = require('oauth2/src/clientSecret.ts');
    secret = await mintSecret();
  } else if (authMethod === 'private_key_jwt' && jwks == null) {
    throw new Error('create-registry: --auth-method private_key_jwt needs --jwks-file or --jwks-json');
  } else if (authMethod !== 'none' && authMethod !== 'private_key_jwt') {
    throw new Error('create-registry: --auth-method must be none, client_secret_basic or private_key_jwt');
  }
  const extras = {};
  for (const kv of args.flags.extra ?? []) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new Error('create-registry: --extra expects key=value, got "' + kv + '"');
    const raw = kv.slice(eq + 1);
    extras[kv.slice(0, eq)] = raw === 'true' ? true : raw === 'false' ? false : (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
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
  await persistClient(platform, {
    clientId,
    kind: 'registry',
    redirectUris: args.flags['redirect-uri'],
    scope: args.flags.scope.flatMap((s) => s.split(/\s+/).filter((t) => t !== '')),
    clientName: args.flagsScalar.name ?? clientId,
    clientUri: args.flagsScalar['client-uri'],
    logoUri: args.flagsScalar['logo-uri'],
    policyUri: args.flagsScalar['policy-uri'],
    tosUri: args.flagsScalar['tos-uri'],
    contacts: args.flags.contact ?? [],
    registeredBy: process.env.USER ?? 'operator',
    registeredAt: Date.now(),
    status: 'active',
    grantTypes,
    tokenEndpointAuthMethod: authMethod,
    allowedAudiences: audiences,
    ...(anyAudience ? { anyAudience: true } : {}),
    ...(allowInsecureRedirect ? { allowInsecureRedirect: true } : {}),
    tokenResponseExtras: extras,
    launchTypes: args.flags['launch-type'] ?? [],
    subjectType,
    ...(allowFeatures != null && allowFeatures.length > 0 ? { allowFeatures } : {}),
    ...(secret != null ? { clientSecretHash: secret.hash } : {}),
    ...(jwks != null ? { jwks } : {}),
  });
  console.log('OK   registry client created: ' + clientId);
  console.log('     redirect_uris: ' + args.flags['redirect-uri'].join(', '));
  console.log('     grant_types:   ' + grantTypes.join(', '));
  console.log('     auth method:   ' + authMethod);
  console.log('     audiences:     ' + (anyAudience ? '(any audience)' : audiences.join(', ')));
  console.log('     subject type:  ' + describeSubjectType(subjectType));
  printDefaultForbids({ allowFeatures: allowFeatures ?? [] });
  if (subjectType === 'pairwise') warnIfNoPseudonyms();
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
  // Only the status changes: written as is, without the registration rules
  // (a row registered before a newer rule must stay suspendable).
  await oauthStorage().setClient(platform, { ...existing, status, updatedAt: Date.now() });
  console.log('OK   client ' + clientId + ' is ' + status);
}

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
  if (client.jwks != null && Array.isArray(client.jwks.keys)) {
    view.jwks = {
      keys: client.jwks.keys.map((k) => ({
        ...(k && k.kid != null ? { kid: k.kid } : {}),
        thumbprint: safeThumbprint(computeThumbprint, k),
      })),
    };
  }
  console.log(JSON.stringify(view, null, 2));
  if (client.kind === 'registry') {
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
  try {
    if (jwk == null || jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
        typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return '(unrecognized key)';
    return computeThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
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

// The single switch the core keys its pseudonym refusal off.
function warnIfNoPseudonyms () {
  if (require('oauth2').PSEUDONYM_SUBJECTS_AVAILABLE === true) return;
  console.log('     WARN pseudonymous subjects are not available on this core yet: /authorize refuses this client ' +
    'until a release that supports them');
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
  for (const flag of ['audience', 'any-audience', 'allow-insecure-redirect', 'subject-type', 'allow-feature']) {
    if ((args.flags[flag] != null || args.flagsScalar[flag] != null) && existing.kind !== 'registry') {
      throw new Error('update: --' + flag + ' applies to registry clients only');
    }
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
  // Replace the inline JWK Set only when --jwks-file/--jwks-json is given;
  // otherwise keep the existing set untouched.
  const jwks = resolveJwks(args);
  if (jwks != null) merged.jwks = jwks;
  // A row written before accountUserId: convert it when the account is on this
  // core (same operation as the master-boot migration), so this whole-row write
  // does not re-install the old field after the boot converted it.
  const row = (await oauthStorage().convertClientAccount(merged, localUserId)) ?? merged;
  // Nothing changed (e.g. the same --subject-type again): no write, so the
  // row's version (and every consent in flight for it) stays as it is.
  const { updatedAt: _before, ...existingRest } = existing;
  const { updatedAt: _after, ...rowRest } = row;
  if (JSON.stringify(sortedKeys(existingRest)) === JSON.stringify(sortedKeys(rowRest))) {
    console.log('OK   client unchanged: ' + clientId);
    return;
  }
  await persistClient(platform, row);
  console.log('OK   client updated: ' + clientId);
  if (row !== merged) console.log('     converted the account reference to the user id');
  if (existing.kind === 'registry' && wantedSubject != null) {
    console.log('     subject type:  ' + describeSubjectType(merged.subjectType));
    if (merged.subjectType === 'pairwise') warnIfNoPseudonyms();
  }
  if (subjectNote != null) {
    console.log();
    console.log('NOTE: existing grants keep their current subject and their sessions keep');
    console.log('      working; each user sees the change of identity mode, and must');
    console.log('      acknowledge it, at their next consent (' + subjectNote.from + ' to ' + subjectNote.to + ').');
  }
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

// --jwks-file <path> | --jwks-json <json> → the inline public JWK Set object,
// or undefined when neither is given. Mutually exclusive. Only parses JSON here;
// deep validation (EC P-256 public keys only, no private `d`) happens in
// persistClient → validatePublicJwkSet, which throws a clear error.
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
  const MULTI_FLAGS = ['redirect-uri', 'scope', 'grant-type', 'cmc-offer', 'audience', 'contact', 'extra', 'launch-type', 'allow-feature'];
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
    'OAuth2 client (app-account) management CLI\n\n' +
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
    '  node bin/oauth-client.js rotate-secret <clientId>\n' +
    '  node bin/oauth-client.js create-registry <clientId> --redirect-uri <uri> --scope <s> --subject-type public|pairwise [flags]\n' +
    '  node bin/oauth-client.js suspend|resume <clientId>\n\n' +
    'Flags (create-registry): a client with no app account; --scope is its maximum\n' +
    'scope set in the grammar of the installed OAuth extension.\n' +
    '  --auth-method none|client_secret_basic|private_key_jwt   (default none; the\n' +
    '                            secret is printed once)\n' +
    '  --audience <url>          (multi; also on update) resource values the client may\n' +
    '                            request (aud); at least one, unless --any-audience\n' +
    '  --any-audience            (also on update) register the client explicitly for any\n' +
    '                            audience (no aud check)\n' +
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
    '                            user and client (refused at authorization on this core\n' +
    '                            for now)\n' +
    '  --allow-feature <name>    (multi; also on update, "none" clears) a feature its\n' +
    '                            grants may use: webhooks, secretSharing (both forbidden\n' +
    '                            on its grants otherwise)\n\n' +
    'Flags (create / update):\n' +
    '  --client-id <opaque-id>   (create only) the client_id to register, instead of\n' +
    '                            the account username. 4-64 chars of A-Z a-z 0-9 . _ ~ -\n' +
    '                            Use it where the username must not reach the platform\n' +
    '                            store or the wire (hashed-PII deployments)\n' +
    '  --redirect-uri <uri>      (multi-valued; at least one required on create)\n' +
    '  --scope <scope-token>     (multi-valued; e.g. cmc:<offer-name> — pair with --cmc-offer)\n' +
    '  --grant-type <name>       (multi-valued; default authorization_code,refresh_token)\n' +
    '  --name <human-name>       client_name shown on the consent screen\n' +
    '  --client-uri <uri>        client_uri shown on the consent screen\n' +
    '  --logo-uri <uri>          logo_uri shown on the consent screen\n' +
    '  --application-type web|native\n' +
    '  --jwks-file <path>        inline public JWK Set (private_key_jwt client auth);\n' +
    '                            EC P-256 (ES256) PUBLIC keys only — a key with a\n' +
    '                            private "d" member is rejected\n' +
    '  --jwks-json <json>        same, as an inline JSON string (mutually exclusive\n' +
    '                            with --jwks-file)\n' +
    '  --cmc-offer <name>=<capabilityUrl>\n' +
    '                            (multi-valued) register a consent-offer reference for\n' +
    '                            granular scope: the app account publishes an open-link\n' +
    '                            consent/request-cmc offer, then registers its capability\n' +
    '                            URL here; clients request it as scope "cmc:<name>"\n' +
    '                            (add the token to --scope as well)\n\n' +
    'Notes:\n' +
    '  - create requires the user to ALREADY exist on THIS core (promotion-only;\n' +
    '    run it on the account\'s home core).\n' +
    '  - revoke requires --yes (operator footgun protection;).\n' +
    '  - HTTP `POST /oauth2/register` (RFC 7591 mode:open) is intentionally deferred.\n'
  );
}

// Account-name lookups, replaceable by tests (no users index there).
const cliEnv = {
  localUserId: (u) => localUserId(u),
  hostingCoreOf: (u) => hostingCoreOf(u),
};

module.exports = {
  parseArgs,
  runCreateRegistry,
  runUpdate,
  runShow,
  runList,
  runSetStatus,
  cliEnv,
};

if (require.main === module) main();
