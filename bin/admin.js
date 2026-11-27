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
//   node bin/admin.js setup finish               # setup done without a first administrator
//   node bin/admin.js claim-code [--role owner] [--scope platform] [--ttl 15m]
//   node bin/admin.js roles list
//   node bin/admin.js roles grant <userId | username> --role <r> --scope <s> [--expires 30d] [--force]
//   node bin/admin.js roles revoke <userId | username> [--role <r>] [--scope <s>] [--force]
//   node bin/admin.js sessions revoke <userId | username>
//
// A multi-core joiner that layers a host-config file passes it with
// `--config <file>`, as for bin/master.js. A code is printed once and never
// stored (only its SHA-256 is): keep the output out of shared logs. Each act
// leaves one line (never a code) in the audit syslog channel when it is on.

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
    scope: 'default-audit-path',
    file: path.resolve(__dirname, '../config/plugins/default-path.js')
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
      case 'setup': status = await setupFinishCommand(ctx); break;
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
  const { setupBlock } = require('../components/business/src/admin/setupBoot.ts');
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
  removeSetupCodeFile();
  process.stdout.write(setupBlock(minted, config, null));
  await recordAct(config, 'setup-code.replaced', {});
  return 0;
}

async function setupFinishCommand ({ config, db }) {
  const setup = require('../components/business/src/admin/setupState.ts');
  const state = await setup.readSetupState(db);
  if (state == null) {
    console.error('admin: no setup state yet: start a core of this platform once (its first boot decides it).');
    return 1;
  }
  if (state.state !== 'pending') {
    console.log('Setup is already ' + state.state + '.');
    return 0;
  }
  await setup.markReady(db, { by: 'cli', now: Date.now() });
  removeSetupCodeFile();
  await recordAct(config, 'setup.finished', {});
  console.log('Setup finished: the platform is ready (registration opens, the setup code no longer works).');
  console.log('The first administrator gets the role with a claim code: node bin/admin.js claim-code --role owner');
  return 0;
}

async function claimCodeCommand ({ config, db }, a) {
  const roles = require('../components/business/src/admin/roles.ts');
  const role = a.role ?? roles.ROLE_OWNER;
  const scope = a.scope ?? roles.SCOPE_PLATFORM;
  if (!roles.isRole(role)) throw new Error('--role must be one of: ' + roles.ROLES.join(', '));
  if (!roles.isScope(scope)) throw new Error('--scope must be ' + SCOPE_GRAMMAR);
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
  await recordAct(config, 'claim-code.created', { role, scope, expiresAt: iso(minted.expiresAt) });
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
    const { hostingsOf, scopeState } = require('../components/business/src/admin/scopes.ts');
    const hostings = hostingsOf(ctx.config);
    const coreIds = await knownCoreIds(ctx);
    for (const { userId, row } of rows) {
      const username = await localUsername(userId);
      console.log(userId + (username != null ? ' (' + username + ')' : ' (not an account of this core)'));
      for (const g of row.grants) {
        const active = roles.activeGrants({ grants: [g] }, now).length === 1;
        // An orphan scope names no region, zone, hosting or core the platform knows: it gives nothing.
        const orphan = active && scopeState(g.scope, hostings, coreIds) === 'orphan';
        console.log('  ' + g.role + ' @ ' + g.scope + '  via ' + g.via + ' by ' + g.grantedBy + ' at ' + iso(g.grantedAt) +
          (g.expiresAt != null ? ', expires ' + iso(g.expiresAt) : '') + (active ? '' : '  [inactive]') + (orphan ? '  [orphan scope]' : ''));
      }
      if (row.sessionsRevokedAt != null) console.log('  sessions revoked at ' + iso(row.sessionsRevokedAt));
    }
    return 0;
  }
  if (a.sub === 'grant') return await grantCommand(ctx, a, roles);
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
  await recordAct(ctx.config, 'role.deleted', { target: userId, role: a.role, scope: a.scope, force: a.force ? 'yes' : null });
  console.log('Revoked: ' + (a.role != null ? a.role + (a.scope != null ? ' @ ' + a.scope : '') : 'every grant') + ' of ' + userId +
    '. Its administrator sessions stop at their next request.');
  return 0;
}

/** `roles grant <userId | username> --role <r> --scope <s> [--expires <when>] [--force]`. */
async function grantCommand (ctx, a, roles) {
  if (a.role == null || !roles.isRole(a.role)) throw new Error('--role must be one of: ' + roles.ROLES.join(', '));
  if (a.scope == null || !roles.isScope(a.scope)) throw new Error('--scope must be ' + SCOPE_GRAMMAR);
  const now = Date.now();
  const expiresAt = a.expires != null ? parseExpiry(a.expires, now) : null;
  const userId = await resolveUserId(a.target);
  try {
    await roles.grantRole(ctx.db, userId, { role: a.role, scope: a.scope, grantedBy: 'cli', via: 'grant', now, expiresAt, force: a.force });
  } catch (err) {
    if (err instanceof roles.LastOwnerError) {
      console.error('admin: ' + err.message + ' (--force replaces it anyway; the platform is then administered with the admin key and a claim code)');
      return 1;
    }
    throw err;
  }
  await recordAct(ctx.config, 'role.granted', { target: userId, role: a.role, scope: a.scope, expiresAt: expiresAt != null ? iso(expiresAt) : null, force: a.force ? 'yes' : null });
  const { hostingsOf, scopeState } = require('../components/business/src/admin/scopes.ts');
  const orphan = scopeState(a.scope, hostingsOf(ctx.config), await knownCoreIds(ctx)) === 'orphan';
  console.log('Granted: ' + a.role + ' @ ' + a.scope + ' to ' + userId + (expiresAt != null ? ', until ' + iso(expiresAt) : '') + '.');
  if (orphan) console.log('Note: ' + a.scope + ' names no region, zone, hosting or core this platform knows: the grant gives nothing until it does.');
  if (a.scope !== roles.SCOPE_PLATFORM) console.log('Role management, claim codes and the other platform-wide writes need a grant at scope platform.');
  return 0;
}

async function sessionsCommand (ctx, a) {
  const roles = require('../components/business/src/admin/roles.ts');
  const userId = await resolveUserId(a.target);
  if (!await roles.revokeSessionsOf(ctx.db, userId, Date.now())) {
    console.error('admin: ' + userId + ' holds no administrator role (no session to revoke)');
    return 1;
  }
  await recordAct(ctx.config, 'sessions.revoked', { target: userId });
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

const SCOPE_GRAMMAR = 'platform, region:<id>, zone:<id>, hosting:<id> or core:<id> (an id is 1 to 128 of A-Z a-z 0-9 . _ -)';

/** The core ids the platform store lists, this core's included. */
async function knownCoreIds ({ config, db }) {
  const ids = new Set([String(config.get('core:id') ?? 'single')]);
  try {
    for (const core of await db.getAllCoreInfos()) if (typeof core?.id === 'string') ids.add(core.id);
  } catch (_e) { /* the core list is not readable: this core alone */ }
  return [...ids];
}

/** `30d`, `12h`, `90m` from now, or an ISO 8601 date-time: milliseconds since the epoch, in the future. */
function parseExpiry (raw, now) {
  const s = String(raw).trim();
  const m = /^(\d+)\s*([mhd])$/i.exec(s);
  let at;
  if (m != null) {
    at = now + Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    at = Date.parse(s);
  } else {
    at = NaN;
  }
  if (!Number.isFinite(at)) throw new Error('--expires must be a duration (90m, 12h, 30d) or an ISO 8601 date-time');
  if (at <= now) throw new Error('--expires must be in the future');
  return at;
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

/** Delete this core's setup code file (it holds an invalid code now). Best-effort. */
function removeSetupCodeFile () {
  const { setupCodeFileOf } = require('../components/business/src/admin/setupBoot.ts');
  const codeFile = setupCodeFileOf(process.argv.slice(2), path.resolve(__dirname, '../config/'));
  try {
    if (fs.existsSync(codeFile)) fs.unlinkSync(codeFile);
  } catch (err) {
    console.error('admin: could not delete the stale ' + codeFile + ': ' + err.message);
  }
}

/**
 * One line per act of this tool (never a code): in the tool's log and, when
 * `audit.syslog.active`, through the audit syslog channel (notice level), so
 * a later investigation finds the acts done from a shell.
 */
async function recordAct (config, act, fields) {
  let osUser = 'unknown';
  try { osUser = require('os').userInfo().username; } catch (_e) { /* no passwd entry in some containers */ }
  const parts = ['admin-cli', act];
  for (const [k, v] of Object.entries(fields)) if (v != null) parts.push(k + ':' + v);
  parts.push('osUser:' + osUser, 'core:' + String(config.get('core:id') ?? 'single'));
  const line = parts.join(' ');
  require('@pryv/boiler').getLogger('admin-cli').info(line);
  if (config.get('audit:syslog:active') !== true) return;
  try {
    const winston = require('winston');
    require('winston-syslog');
    const transport = new winston.transports.Syslog(config.get('audit:syslog:options'));
    transport.on('error', (err) => console.error('admin: the syslog line was not sent: ' + err.message));
    const logger = winston.createLogger({ levels: winston.config.syslog.levels, format: winston.format.printf((i) => i.message), transports: [transport] });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      logger.on('finish', () => { clearTimeout(timer); resolve(); });
      logger.log({ level: 'notice', message: line });
      logger.end();
    });
  } catch (err) {
    console.error('admin: the syslog line was not sent: ' + err.message);
  }
}

function parseArgs (list) {
  const out = { command: null, sub: null, target: null, positional: [], new: false, hash: false, force: false, role: null, scope: null, ttl: null, expires: null, config: null };
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
    else if (a === '--expires') out.expires = value();
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
    case 'setup':
      out.sub = rest.shift() ?? null;
      if (out.sub === 'finish' && rest.length === 0) break;
      throw new Error('setup finish');
    case 'claim-code':
      if (rest.length > 0) throw new Error('claim-code takes options only');
      break;
    case 'roles':
      out.sub = rest.shift() ?? null;
      if (out.sub === 'list' && rest.length === 0) break;
      if ((out.sub === 'revoke' || out.sub === 'grant') && rest.length === 1) { out.target = rest[0]; break; }
      throw new Error('roles list | roles grant <userId | username> --role <r> --scope <s> | roles revoke <userId | username>');
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
    '  node bin/admin.js setup finish                mark setup done without a first administrator (automated',
    '                                                installs: the first administrator then claims a claim code)',
    '  node bin/admin.js claim-code [--role owner] [--scope platform] [--ttl 15m]',
    '                                                a one-time administrator code (default 15 min, at most 24h)',
    '  node bin/admin.js roles list                  every administrator and its grants',
    '  node bin/admin.js roles grant <userId|username> --role <r> --scope <s> [--expires <when>] [--force]',
    '                                                give a role at a scope (or replace that grant); <when>:',
    '                                                90m, 12h, 30d or an ISO 8601 date-time; replacing the',
    '                                                last lasting owner grant by an expiring one needs --force',
    '  node bin/admin.js roles revoke <userId|username> [--role <r>] [--scope <s>] [--force]',
    '                                                remove grants; the last owner grant needs --force',
    '  node bin/admin.js sessions revoke <userId|username>',
    '                                                refuse every administrator session opened until now',
    '',
    'Roles: owner, operator, support, auditor, app-reviewer, viewer.',
    'Scopes: platform, region:<id>, zone:<id>, hosting:<id>, core:<id>.',
    '',
    'Options:',
    '  --config <file>   a host-config file layered on top (multi-core joiner), as for bin/master.js',
    '',
    'A username is looked up on this core; give the user id for an account of another core.',
    ''
  ].join('\n'));
}
