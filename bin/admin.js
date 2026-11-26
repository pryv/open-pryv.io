#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: platform setup and administrators, from a core's shell.
// Talks to the platform store directly, so it works while the API is down.
// Shell access to a core is the proof of being the operator.
//
//   node bin/admin.js setup-code                 # setup state, pending code times
//   node bin/admin.js setup-code --new           # replace the setup code (printed once)
//   node bin/admin.js setup-code --hash [<code>] # SHA-256 for setup.codeHash (no store access)
//   node bin/admin.js claim-code [--role owner] [--scope platform] [--ttl 15m]
//   node bin/admin.js roles list
//   node bin/admin.js roles revoke <userId | username> [--role <r>] [--scope <s>] [--force]
//   node bin/admin.js sessions revoke <userId | username>
//
// A multi-core joiner that layers a host-config file passes it with
// `--config <file>`, as for bin/master.js. A code is printed once and never
// stored (only its SHA-256 is): keep the output out of shared logs.

const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(argv.length === 0 ? 1 : 0);
}

let args;
try {
  args = parseArgs(argv);
} catch (err) {
  console.error('admin: ' + err.message);
  printUsage(process.stderr);
  process.exit(2);
}

// `setup-code --hash` needs no configuration nor store.
if (args.command === 'setup-code' && args.hash) {
  process.exit(hashCommand(args));
}

if (args.config != null && !fs.existsSync(path.resolve(process.cwd(), args.config))) {
  console.error(`--config: file not found: ${args.config}`);
  process.exit(2);
}

require('@pryv/boiler').init({
  appName: 'admin',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../config/plugins/systemStreams')
  }, {
    plugin: require('../config/plugins/core-identity')
  }, ...(args.config != null
    ? [{ scope: 'host-config', file: path.resolve(process.cwd(), args.config) }]
    : [])]
});

(async () => {
  try {
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const storages = require('storages');
    await storages.init(config);
    const db = storages.platformDB;
    const ctx = { config, db, storages };
    let status;
    switch (args.command) {
      case 'setup-code': status = await setupCodeCommand(ctx, args); break;
      case 'claim-code': status = await claimCodeCommand(ctx, args); break;
      case 'roles': status = await rolesCommand(ctx, args); break;
      case 'sessions': status = await sessionsCommand(ctx, args); break;
      default: throw new Error('unknown command');
    }
    process.exit(status);
  } catch (err) {
    console.error('admin: ' + ((err && err.message) || err));
    process.exit(1);
  }
})();

// ------------------------------------------------------------ commands

function hashCommand (a) {
  const { generateCode, formatCode, hashCode, normalizeCode } = require('../components/business/src/admin/codes.ts');
  if (a.positional.length > 1) {
    console.error('admin: setup-code --hash takes one code at most');
    return 2;
  }
  if (a.positional.length === 1) {
    const canonical = normalizeCode(a.positional[0]);
    if (canonical == null) {
      console.error('admin: not a setup code: 26 characters of Crockford base32 (0-9, A-Z without I, L, O, U), dashes and spaces ignored');
      return 2;
    }
    console.log(hashCode(canonical));
    return 0;
  }
  const code = generateCode();
  console.log('A new setup code and its SHA-256 for `setup.codeHash` (env pryv_setup__codeHash).');
  console.log('Give the code to the person doing the setup; only the hash goes in the configuration.');
  console.log('');
  console.log('  code   ' + formatCode(code));
  console.log('  hash   ' + hashCode(code));
  return 0;
}

async function setupCodeCommand ({ config, db }, a) {
  const setup = require('../components/business/src/admin/setupState.ts');
  const { readAdminConfig } = require('../components/business/src/admin/config.ts');
  const { setupBlock, SETUP_CODE_FILE } = require('../components/business/src/admin/setupBoot.ts');
  const state = await setup.readSetupState(db);
  if (state == null) {
    console.error('admin: no setup state yet: start a core of this platform once (its first boot decides it).');
    return 1;
  }
  if (!a.new) {
    console.log('setup state   ' + state.state + (state.readyAt != null ? ' (since ' + iso(state.readyAt) + ', by ' + state.readyBy + ')' : ''));
    if (state.state === 'pending') {
      const code = await setup.pendingSetupCode(db);
      if (code == null) {
        console.log('setup code    none valid (expired, used or replaced): mint one with --new');
      } else {
        console.log('setup code    issued ' + iso(code.createdAt) + ', valid until ' + iso(code.expiresAt) +
          (code.supplied ? ' (operator-supplied, setup.codeHash)' : '') + '; it cannot be shown again, --new replaces it');
      }
    }
    return 0;
  }
  if (state.state !== 'pending') {
    console.error('admin: setup is ' + state.state + ': there is no setup code to replace. An administrator role is given with `claim-code`.');
    return 1;
  }
  const coreId = String(config.get('core:id') ?? 'single');
  const minted = await setup.mintSetupCode(db, { coreId, ttlMs: readAdminConfig(config).setup.codeTtlMs, now: Date.now() });
  if (minted == null) {
    console.error('admin: setup is no longer pending.');
    return 1;
  }
  // The file of the previous code holds an invalid code now.
  const codeFile = path.join(setupCodeDir(), SETUP_CODE_FILE);
  try {
    if (fs.existsSync(codeFile)) fs.unlinkSync(codeFile);
  } catch (err) {
    console.error('admin: could not delete the stale ' + codeFile + ': ' + err.message);
  }
  process.stdout.write(setupBlock(minted, config, null));
  return 0;
}

async function claimCodeCommand ({ db }, a) {
  const roles = require('../components/business/src/admin/roles.ts');
  const role = a.role ?? roles.ROLE_OWNER;
  const scope = a.scope ?? roles.SCOPE_PLATFORM;
  if (!roles.isRole(role)) throw new Error('--role must be one of: ' + roles.ROLES.join(', '));
  if (!roles.isScope(scope)) throw new Error('--scope must be: ' + roles.SCOPE_PLATFORM);
  const ttlMs = a.ttl != null ? parseTtl(a.ttl, roles.CLAIM_TTL_MAX_MS) : undefined;
  const minted = await roles.mintClaimCode(db, { role, scope, mintedBy: 'cli', now: Date.now(), ttlMs });
  const rule = '='.repeat(72);
  process.stdout.write([
    '',
    rule,
    '  ADMINISTRATOR CLAIM CODE: one-time, role ' + role + ' at scope ' + scope + ', valid until ' + iso(minted.expiresAt),
    '',
    '      ' + minted.display,
    '',
    '  Whoever holds it and signs in gets the role: hand it over directly.',
    '  It is claimed with POST /system/admin/roles/claim (or in the portal),',
    '  signed in on the account\'s home core.',
    rule,
    ''
  ].join('\n') + '\n');
  return 0;
}

async function rolesCommand (ctx, a) {
  const roles = require('../components/business/src/admin/roles.ts');
  if (a.sub === 'list') {
    const rows = await roles.listRoleRows(ctx.db);
    if (rows.length === 0) {
      console.log('No administrator role on this platform.');
      return 0;
    }
    const now = Date.now();
    for (const { userId, row } of rows) {
      const username = await localUsername(userId);
      console.log(userId + (username != null ? ' (' + username + ')' : ' (not an account of this core)'));
      for (const g of row.grants) {
        const active = roles.activeGrants({ grants: [g] }, now).length === 1;
        console.log('  ' + g.role + ' @ ' + g.scope + '  via ' + g.via + ' by ' + g.grantedBy + ' at ' + iso(g.grantedAt) +
          (g.expiresAt != null ? ', expires ' + iso(g.expiresAt) : '') + (active ? '' : '  [inactive]'));
      }
      if (row.sessionsRevokedAt != null) console.log('  sessions revoked at ' + iso(row.sessionsRevokedAt));
    }
    return 0;
  }
  // revoke
  const userId = await resolveUserId(a.target);
  let revoked;
  try {
    revoked = await roles.revokeRole(ctx.db, userId, { role: a.role, scope: a.scope, now: Date.now(), force: a.force });
  } catch (err) {
    if (err instanceof roles.LastOwnerError) {
      console.error('admin: ' + err.message + ' (--force removes it anyway; the platform is then administered with the admin key and a claim code)');
      return 1;
    }
    throw err;
  }
  if (!revoked) {
    console.error('admin: no matching grant for ' + userId);
    return 1;
  }
  console.log('Revoked: ' + (a.role != null ? a.role + (a.scope != null ? ' @ ' + a.scope : '') : 'every grant') + ' of ' + userId +
    '. Its administrator sessions stop at their next request.');
  return 0;
}

async function sessionsCommand (ctx, a) {
  const roles = require('../components/business/src/admin/roles.ts');
  const userId = await resolveUserId(a.target);
  if (!await roles.revokeSessionsOf(ctx.db, userId, Date.now())) {
    console.error('admin: ' + userId + ' holds no administrator role (no session to revoke)');
    return 1;
  }
  console.log('Every administrator session of ' + userId + ' opened until now is refused from its next request.');
  return 0;
}

// ------------------------------------------------------------ helpers

/** A user id given as is, or the id of a username of this core. */
async function resolveUserId (target) {
  const roles = require('../components/business/src/admin/roles.ts');
  if ((await roles.readRoleRow(require('storages').platformDB, target).catch(() => null)) != null) return target;
  const { getUsersRepository } = require('business/src/users/index.ts');
  const repository = await getUsersRepository();
  const id = await repository.getUserIdForUsername(target.toLowerCase()).catch(() => null);
  if (id != null) return id;
  if (/^[A-Za-z0-9._-]{1,128}$/.test(target)) return target;
  throw new Error('not a user id, nor a username of this core: ' + target);
}

async function localUsername (userId) {
  try {
    const { getUsersRepository } = require('business/src/users/index.ts');
    return (await (await getUsersRepository()).getUsernameForUserId(userId)) ?? null;
  } catch (_e) {
    return null;
  }
}

/** `15m`, `2h`, `30` (minutes): milliseconds, more than 0 and at most `maxMs`. */
function parseTtl (raw, maxMs) {
  const m = /^(\d+)\s*([mh]?)$/i.exec(String(raw).trim());
  if (m == null) throw new Error('--ttl must be minutes (15, 15m) or hours (2h)');
  const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3600000 : 60000);
  if (!(ms > 0) || ms > maxMs) throw new Error('--ttl must be more than 0 and at most 24h');
  return ms;
}

function iso (ms) {
  return new Date(ms).toISOString();
}

/** The folder of the setup code file: that of the `--config` file, else the base config folder (as bin/master.js). */
function setupCodeDir () {
  if (args.config != null) return path.dirname(path.resolve(process.cwd(), args.config));
  return path.resolve(__dirname, '../config/');
}

function parseArgs (list) {
  const out = { command: null, sub: null, target: null, positional: [], new: false, hash: false, force: false, role: null, scope: null, ttl: null, config: null };
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const value = () => {
      const v = list[++i];
      if (v == null || v.startsWith('--')) throw new Error(a + ' needs a value');
      return v;
    };
    if (a === '--new') out.new = true;
    else if (a === '--hash') out.hash = true;
    else if (a === '--force') out.force = true;
    else if (a === '--role') out.role = value();
    else if (a === '--scope') out.scope = value();
    else if (a === '--ttl') out.ttl = value();
    else if (a === '--config') out.config = value();
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else rest.push(a);
  }
  out.command = rest.shift() ?? null;
  switch (out.command) {
    case 'setup-code':
      if (out.new && out.hash) throw new Error('--new and --hash are exclusive');
      if (!out.hash && rest.length > 0) throw new Error('setup-code takes no argument (a code is hashed with --hash <code>)');
      out.positional = rest;
      break;
    case 'claim-code':
      if (rest.length > 0) throw new Error('claim-code takes options only');
      break;
    case 'roles':
      out.sub = rest.shift() ?? null;
      if (out.sub === 'list' && rest.length === 0) break;
      if (out.sub === 'revoke' && rest.length === 1) { out.target = rest[0]; break; }
      throw new Error('roles list | roles revoke <userId | username>');
    case 'sessions':
      out.sub = rest.shift() ?? null;
      if (out.sub === 'revoke' && rest.length === 1) { out.target = rest[0]; break; }
      throw new Error('sessions revoke <userId | username>');
    default:
      throw new Error('unknown command ' + JSON.stringify(out.command));
  }
  return out;
}

function printUsage (stream) {
  stream.write([
    'Platform setup and administrators, from a core\'s shell (works while the API is down).',
    '',
    'Usage:',
    '  node bin/admin.js setup-code                  setup state and the pending code\'s times',
    '  node bin/admin.js setup-code --new            replace the setup code; the new one is printed once',
    '  node bin/admin.js setup-code --hash           generate a code and its SHA-256 for setup.codeHash',
    '  node bin/admin.js setup-code --hash <code>    the SHA-256 of a code you chose (26 Crockford base32',
    '                                                characters; it lands in your shell history)',
    '  node bin/admin.js claim-code [--role owner] [--scope platform] [--ttl 15m]',
    '                                                a one-time administrator code (default 15 min, at most 24h)',
    '  node bin/admin.js roles list                  every administrator and its grants',
    '  node bin/admin.js roles revoke <userId|username> [--role <r>] [--scope <s>] [--force]',
    '                                                remove grants; the last owner grant needs --force',
    '  node bin/admin.js sessions revoke <userId|username>',
    '                                                refuse every administrator session opened until now',
    '',
    'Options:',
    '  --config <file>   a host-config file layered on top (multi-core joiner), as for bin/master.js',
    '',
    'A username is looked up on this core; give the user id for an account of another core.',
    ''
  ].join('\n'));
}
