#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: the platform-wide configuration held in the platform store,
// from a core's shell. Talks to the platform store directly, so it works while
// the API is down. Running cores pick a change up within
// platform.configPollSeconds.
//
//   node bin/platform-config.js list
//   node bin/platform-config.js get <key>
//   node bin/platform-config.js set <key> <value>     # JSON, or a plain string
//   node bin/platform-config.js unset <key>           # the key reads the files again
//   node bin/platform-config.js seed [--keys a,b]     # copy this core's values where no row exists
//   node bin/platform-config.js export                # JSON of the rows
//   node bin/platform-config.js import <file>         # set every key of an export (or { key: value })
//
// A key with no row reads the configuration files and the environment, as
// before; a row replaces that value on every core.

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
  console.error('platform-config: ' + err.message);
  printUsage(process.stderr);
  process.exit(2);
}

if (args.config != null && !fs.existsSync(path.resolve(process.cwd(), args.config))) {
  console.error(`--config: file not found: ${args.config}`);
  process.exit(2);
}

require('@pryv/boiler').init({
  appName: 'platform-config',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'serviceInfo',
    key: 'service',
    urlFromKey: 'serviceInfoUrl'
  }, {
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
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
    const ctx = { config, db: storages.platformDB, pc: require('../components/business/src/platformConfig/index.ts') };
    let status;
    switch (args.command) {
      case 'list': status = await listCommand(ctx); break;
      case 'get': status = await getCommand(ctx, args.key); break;
      case 'set': status = await setCommand(ctx, args.key, args.value); break;
      case 'unset': status = await unsetCommand(ctx, args.key); break;
      case 'seed': status = await seedCommand(ctx, args.keys); break;
      case 'export': status = await exportCommand(ctx); break;
      case 'import': status = await importCommand(ctx, args.file); break;
      default: throw new Error('unknown command');
    }
    process.exit(status);
  } catch (err) {
    console.error('platform-config: ' + ((err && err.message) || err));
    process.exit(1);
  }
})();

// ------------------------------------------------------------ commands

function by (config) {
  return { kind: 'cli', coreId: String(config.get('core:id') || 'single') };
}

/** What a core reads for a key: the row's value when the schema accepts it, else the local value. */
function describe ({ config, pc }, key, entry) {
  const def = pc.keyDef(key);
  const local = config.getLocal(pc.configPath(key));
  const loadable = entry != null && def != null && pc.valueErrors(key, entry.value) == null;
  return { def, local, loadable, effective: loadable ? entry.value : local };
}

async function listCommand (ctx) {
  const { db, pc } = ctx;
  const rows = new Map((await pc.listEntries(db)).map((e) => [e.key, e]));
  const keys = Object.keys(pc.schema()).sort();
  console.log('revision ' + await pc.currentRev(db));
  if (keys.length === 0) console.log('No key of this release can be held in the platform store.');
  for (const key of keys) {
    const entry = rows.get(key) ?? null;
    const d = describe(ctx, key, entry);
    const flags = [d.def.appliesAt, d.def.sensitive ? 'sensitive' : null].filter(Boolean).join(', ');
    if (d.loadable) {
      console.log(key + ' = ' + JSON.stringify(entry.value) + '  [platform store, ' + flags + '] by ' + entry.updatedBy.kind +
        (entry.updatedBy.userId != null ? ' ' + entry.updatedBy.userId : '') + ' on ' + entry.updatedBy.coreId + ' at ' + iso(entry.updatedAt));
      if (d.local !== undefined && JSON.stringify(d.local) !== JSON.stringify(entry.value)) {
        console.log('  hides this core\'s local value ' + JSON.stringify(d.local));
      }
    } else {
      console.log(key + ' = ' + JSON.stringify(d.local) + '  [local, ' + flags + ']' + (entry != null ? '  (the store row is refused by the schema)' : ''));
    }
  }
  for (const [key, entry] of rows) {
    if (pc.keyDef(key) == null) console.log(key + ' = ' + JSON.stringify(entry.value) + '  [not a key of this release: ignored here, a newer core may use it]');
  }
  return 0;
}

async function getCommand (ctx, key) {
  const { db, pc } = ctx;
  if (!pc.isValidKeyName(key)) throw new pc.UnknownKeyError(key);
  const entry = await pc.getEntry(db, key);
  if (pc.keyDef(key) == null && entry == null) throw new pc.UnknownKeyError(key);
  const d = describe(ctx, key, entry);
  console.log(JSON.stringify({
    key,
    source: d.loadable ? 'platform-db' : 'local',
    effective: d.effective,
    value: entry?.value,
    local: d.local,
    updatedAt: entry?.updatedAt,
    updatedBy: entry?.updatedBy
  }, null, 2));
  return 0;
}

async function setCommand ({ config, db, pc }, key, raw) {
  const value = parseValue(raw);
  try {
    const { rev } = await pc.setEntry(db, key, value, by(config));
    log(config, 'set ' + key);
    console.log(key + ' = ' + JSON.stringify(value) + ' in the platform store (revision ' + rev + '). Running cores read it within platform.configPollSeconds' +
      (pc.keyDef(key).appliesAt === 'restart' ? '; read at boot: restart the cores.' : '.'));
    return 0;
  } catch (err) {
    if (err instanceof pc.InvalidValueError) {
      console.error('platform-config: ' + err.message + ': ' + err.errors.map((e) => (e.path || '#') + ' ' + (e.message || e.code)).join('; '));
      return 1;
    }
    throw err;
  }
}

async function unsetCommand ({ config, db, pc }, key) {
  const { before, rev } = await pc.unsetEntry(db, key, by(config));
  if (before == null) {
    console.log(key + ' has no row in the platform store: nothing to do.');
    return 0;
  }
  log(config, 'unset ' + key);
  console.log(key + ' removed from the platform store (revision ' + rev + '): each core reads its configuration files again.');
  return 0;
}

async function seedCommand ({ config, db, pc }, keys) {
  const out = await pc.seed(config, db, by(config), keys ?? undefined);
  for (const key of out.written) console.log('written  ' + key);
  for (const s of out.skipped) console.log('skipped  ' + s.key + ' (' + s.reason + ')');
  if (out.written.length > 0) log(config, 'seed ' + out.written.join(','));
  console.log(out.written.length + ' key(s) written (revision ' + out.rev + ').');
  return 0;
}

/** Rows of this release's keys under `entries`; rows of other keys apart, under `otherKeys` (import leaves them out). */
async function exportCommand ({ db, pc }) {
  const entries = {};
  const otherKeys = {};
  for (const e of await pc.listEntries(db)) (pc.keyDef(e.key) != null ? entries : otherKeys)[e.key] = e.value;
  const doc = { rev: await pc.currentRev(db), entries };
  if (Object.keys(otherKeys).length > 0) doc.otherKeys = otherKeys;
  console.log(JSON.stringify(doc, null, 2));
  return 0;
}

/**
 * Sets every key of `entries` (an export's `otherKeys` are not imported).
 * Every key and value is checked before the first write; the keys are then
 * written one by one: if the store fails part way, the keys already written
 * stay, and both lists are printed.
 */
async function importCommand ({ config, db, pc }, file) {
  const doc = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
  const entries = doc != null && typeof doc.entries === 'object' && doc.entries != null ? doc.entries : doc;
  if (entries == null || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('the file must hold { "entries": { key: value } } or { key: value }');
  if (doc.otherKeys != null) console.log('Not imported (keys this release does not know): ' + Object.keys(doc.otherKeys).join(', '));
  const problems = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!pc.isValidKeyName(key) || pc.keyDef(key) == null) { problems.push(key + ': not a key of this release (a row of an older or newer release)'); continue; }
    if (pc.valueErrors(key, value) != null) problems.push(key + ': value refused by the schema');
  }
  if (problems.length > 0) {
    console.error('platform-config: nothing imported:\n  ' + problems.join('\n  '));
    return 1;
  }
  const keys = Object.keys(entries);
  const written = [];
  let rev = await pc.currentRev(db);
  try {
    for (const key of keys) {
      rev = (await pc.setEntry(db, key, entries[key], by(config))).rev;
      written.push(key);
    }
  } catch (err) {
    if (written.length > 0) log(config, 'import (partial) ' + written.join(','));
    console.error('platform-config: the import stopped: ' + err.message);
    console.error('  written:     ' + (written.length > 0 ? written.join(', ') : 'none'));
    console.error('  not written: ' + keys.filter((k) => !written.includes(k)).join(', '));
    return 1;
  }
  log(config, 'import ' + keys.join(','));
  console.log(keys.length + ' key(s) imported (revision ' + rev + ').');
  return 0;
}

// ------------------------------------------------------------ helpers

/** JSON when it parses, else the text as a string. */
function parseValue (raw) {
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return raw;
  }
}

function iso (ms) {
  return new Date(ms).toISOString();
}

/** One line per write in the tool's log (the row records `updatedBy: cli` too). */
function log (config, act) {
  let osUser = 'unknown';
  try { osUser = require('os').userInfo().username; } catch (_e) { /* no passwd entry in some containers */ }
  require('@pryv/boiler').getLogger('platform-config-cli').info('platform-config-cli ' + act + ' osUser:' + osUser + ' core:' + String(config.get('core:id') || 'single'));
}

function parseArgs (list) {
  const out = { command: null, key: null, value: null, file: null, keys: null, config: null };
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const value = () => {
      const v = list[++i];
      if (v == null || v.startsWith('--')) throw new Error(a + ' needs a value');
      return v;
    };
    if (a === '--keys') out.keys = value().split(',').map((s) => s.trim()).filter((s) => s !== '');
    else if (a === '--config') out.config = value();
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else rest.push(a);
  }
  out.command = rest.shift() ?? null;
  const exactly = (n, usage) => { if (rest.length !== n) throw new Error(usage); };
  switch (out.command) {
    case 'list': case 'export': exactly(0, out.command + ' takes no argument'); break;
    case 'get': case 'unset': exactly(1, out.command + ' <key>'); out.key = rest[0]; break;
    case 'set': exactly(2, 'set <key> <value>'); out.key = rest[0]; out.value = rest[1]; break;
    case 'import': exactly(1, 'import <file>'); out.file = rest[0]; break;
    case 'seed': exactly(0, 'seed [--keys a,b]'); break;
    default: throw new Error('unknown command ' + JSON.stringify(out.command));
  }
  if (out.keys != null && out.command !== 'seed') throw new Error('--keys goes with seed');
  return out;
}

function printUsage (stream) {
  stream.write([
    'Platform-wide configuration held in the platform store, from a core\'s shell (works while the API is down).',
    'A key with no row reads the configuration files and the environment; a row replaces that value on every core.',
    '',
    'Usage:',
    '  node bin/platform-config.js list                every key the store may hold, its value and where it comes from',
    '  node bin/platform-config.js get <key>',
    '  node bin/platform-config.js set <key> <value>   the value as JSON, or a plain string',
    '  node bin/platform-config.js unset <key>         remove the row: the key reads the files again',
    '  node bin/platform-config.js seed [--keys a,b]   copy this core\'s current values where no row exists',
    '  node bin/platform-config.js export              the rows as JSON (rows of keys this release does not',
    '                                                know apart, under otherKeys)',
    '  node bin/platform-config.js import <file>       set every key of an export\'s entries (or of { key: value });',
    '                                                all are checked first, then written one by one: a store',
    '                                                failure part way leaves the keys written so far (both',
    '                                                lists are printed)',
    '',
    'Options:',
    '  --config <file>   a host-config file layered on top (multi-core joiner), as for bin/master.js',
    ''
  ].join('\n'));
}
