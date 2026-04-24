#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// CLI for inspecting and editing in-process mail templates in PlatformDB.
// Works whether the master process is running or not — changes propagate
// to other cores via rqlite replication, and to sibling workers on the
// local core via IPC (see `process.send({type:'mail:template-invalidate'})`
// in the admin-API routes). When this CLI runs standalone, no IPC push
// happens — sibling workers will pick up the change on their next periodic
// refresh OR the next `mail.refresh()` call.
//
// Usage:
//   node bin/mail.js templates list
//   node bin/mail.js templates get <type> <lang> <part>
//   node bin/mail.js templates set <type> <lang> <part> --file <path>
//   node bin/mail.js templates delete <type> <lang> [part]
//   node bin/mail.js templates seed --from <dir>
//   node bin/mail.js send-test <type> <lang> <recipient-email>

const path = require('node:path');
const fs = require('node:fs/promises');

if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'mail-cli',
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

    const platformDB = await initPlatformDB();

    switch (args.command) {
      case 'templates':
        await runTemplates(platformDB, args);
        break;
      case 'send-test':
        await runSendTest(platformDB, args);
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

async function initPlatformDB () {
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();
  const rqliteUrl = config.get('storages:engines:rqlite:url') || 'http://localhost:4001';
  await waitForRqlite(rqliteUrl);
  await require('storages').init(config);
  return require('storages').platformDB;
}

async function waitForRqlite (url, timeoutMs = 30000) {
  const readyzUrl = url.replace(/\/$/, '') + '/readyz';
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(readyzUrl);
      if (res.ok) return;
    } catch (_) { /* retry */ }
    if (!notified) {
      console.error(`Waiting for PlatformDB (rqlited) at ${url} …`);
      notified = true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`PlatformDB (rqlited) not reachable at ${url} after ${timeoutMs}ms.`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runTemplates (platformDB, args) {
  const sub = args.subcommand;
  switch (sub) {
    case 'list': return await runList(platformDB);
    case 'get': return await runGet(platformDB, args);
    case 'set': return await runSet(platformDB, args);
    case 'delete': return await runDelete(platformDB, args);
    case 'seed': return await runSeed(platformDB, args);
    default:
      throw new Error('templates: unknown subcommand "' + (sub || '') + '" (expected list|get|set|delete|seed)');
  }
}

async function runList (platformDB) {
  const rows = await platformDB.getAllMailTemplates();
  if (rows.length === 0) {
    console.log('(no templates — PlatformDB has zero mail-template rows)');
    return;
  }
  rows.sort((a, b) => (a.type + a.lang + a.part).localeCompare(b.type + b.lang + b.part));
  const header = ['type', 'lang', 'part', 'len'];
  console.log(header.join('\t'));
  for (const row of rows) {
    console.log([row.type, row.lang, row.part, row.pug.length].join('\t'));
  }
}

async function runGet (platformDB, args) {
  requirePositional(args, ['type', 'lang', 'part'], 'templates get');
  const pug = await platformDB.getMailTemplate(args.type, args.lang, args.part);
  if (pug == null) {
    console.error(`templates get: no row for ${args.type}/${args.lang}/${args.part}`);
    process.exit(3);
  }
  process.stdout.write(pug);
  if (!pug.endsWith('\n')) process.stdout.write('\n');
}

async function runSet (platformDB, args) {
  requirePositional(args, ['type', 'lang', 'part'], 'templates set');
  if (!args.file) throw new Error('templates set: --file <path> is required');
  const pug = await fs.readFile(args.file, 'utf8');
  await platformDB.setMailTemplate(args.type, args.lang, args.part, pug);
  console.log(`set ${args.type}/${args.lang}/${args.part} (${pug.length} byte(s))`);
  console.log('Other workers on this core will refresh on their next request; other cores via rqlite replication.');
}

async function runDelete (platformDB, args) {
  requirePositional(args, ['type', 'lang'], 'templates delete');
  await platformDB.deleteMailTemplate(args.type, args.lang, args.part || undefined);
  const scope = args.part ? `${args.type}/${args.lang}/${args.part}` : `${args.type}/${args.lang}/* (both parts)`;
  console.log(`deleted ${scope}`);
}

async function runSeed (platformDB, args) {
  if (!args.from) throw new Error('templates seed: --from <dir> is required');
  const root = path.resolve(args.from);
  try { await fs.access(root); } catch (_) {
    throw new Error(`templates seed: directory not readable at ${root}`);
  }
  let count = 0;
  for (const type of await listDirs(root)) {
    for (const lang of await listDirs(path.join(root, type))) {
      const langDir = path.join(root, type, lang);
      for (const file of await fs.readdir(langDir)) {
        if (!file.endsWith('.pug')) continue;
        const part = file.replace(/\.pug$/, '');
        const pug = await fs.readFile(path.join(langDir, file), 'utf8');
        await platformDB.setMailTemplate(type, lang, part, pug);
        count++;
      }
    }
  }
  console.log(`seeded ${count} row(s) from ${root}`);
  console.log('NOTE: this subcommand overwrites existing rows — for empty-only seeding, use the master-boot auto-seed instead.');
}

async function runSendTest (platformDB, args) {
  requirePositional(args, ['type', 'lang', 'recipient'], 'send-test');
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();
  const smtp = config.get('services:email:smtp');
  const from = config.get('services:email:from');
  if (!smtp || !smtp.host) throw new Error('send-test: services.email.smtp.host is required in config');

  const mail = require('../components/mail/src');
  await mail.init({
    getAllMailTemplates: platformDB.getAllMailTemplates.bind(platformDB),
    smtp,
    from,
    defaultLang: config.get('services:email:defaultLang') || 'en'
  });
  const result = await mail.send({
    type: args.type,
    lang: args.lang,
    recipient: { name: args.recipient, email: args.recipient },
    substitutions: { username: 'send-test', email: args.recipient }
  });
  await mail.close();
  console.log(`send-test ok → ${args.recipient}`);
  if (process.env.DEBUG && result.result) console.log(JSON.stringify(result.result, null, 2));
}

async function listDirs (parent) {
  const entries = await fs.readdir(parent, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

// ---------------------------------------------------------------------------
// Parse + help
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const args = { command: null, positional: [] };
  // Extract flags first (--file <path>, --from <dir>) and leave positional.
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') { args.file = argv[++i]; continue; }
    if (a === '--from') { args.from = argv[++i]; continue; }
    positional.push(a);
  }
  args.command = positional[0];
  switch (args.command) {
    case 'templates':
      args.subcommand = positional[1];
      [args.type, args.lang, args.part] = positional.slice(2);
      break;
    case 'send-test':
      [args.type, args.lang, args.recipient] = positional.slice(1);
      break;
  }
  return args;
}

function requirePositional (args, names, cmd) {
  for (const name of names) {
    if (args[name] == null || args[name] === '') {
      throw new Error(`${cmd}: <${name}> is required`);
    }
  }
}

function printUsage (stream) {
  stream.write('Usage:\n');
  stream.write('  node bin/mail.js templates list\n');
  stream.write('  node bin/mail.js templates get <type> <lang> <part>\n');
  stream.write('  node bin/mail.js templates set <type> <lang> <part> --file <path>\n');
  stream.write('  node bin/mail.js templates delete <type> <lang> [part]\n');
  stream.write('  node bin/mail.js templates seed --from <dir>\n');
  stream.write('  node bin/mail.js send-test <type> <lang> <recipient-email>\n');
  stream.write('\n');
  stream.write('<part> is "html" or "subject" (without the .pug suffix).\n');
  stream.write('The seed subcommand OVERWRITES existing rows; for empty-only seeding\n');
  stream.write('point services.email.templatesRootDir at the dir and restart master.\n');
}
