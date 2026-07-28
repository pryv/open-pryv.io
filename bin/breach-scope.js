#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: scope a suspected breach from a single compromised accessId.
//
// Given an accessId and a time window, it resolves the owning subject, pulls
// that subject's audit rows for the access over the window, and renders the
// technical inputs for a breach notification (subjects affected, records
// affected, categories of data by stream scope, plus operator-narrative
// placeholders) as JSON and/or Markdown.
//
// Read-only and in-process, like the other operator tools here: it needs no
// API credential — possession of core-local config + storage IS the operator
// authorization. It reads THIS core's local storage, so it must run on the
// subject's home core; when run elsewhere it resolves and prints where to run.
//
// Usage:
//   node bin/breach-scope.js --access <accessId> --since <iso8601> \
//        [--until <iso8601>] [--output report.json] [--output report.md] \
//        [--json] [--verbose]
//
// Default output is Markdown to stdout; --json switches stdout to JSON; each
// --output writes a file whose format is chosen by extension (.json / .md).
//
// Exit codes: 0 report produced; 1 unexpected error; 2 usage/argument error;
// 3 accessId not in the reverse-index; 4 not the subject's home core (the
// resolved core url is printed); 5 owning subject was erased (tombstone).

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'breach-scope',
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
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('breach-scope: ' + err.message);
    printUsage(process.stderr);
    process.exit(2);
  }
  const trace = args.verbose ? (m) => console.error('breach-scope: ' + m) : () => {};

  try {
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    await require('storages').init(config);

    const { getStorageLayer, getUsersLocalIndex } = require('storage');
    const storageLayer = await getStorageLayer();
    const usersIndex = await getUsersLocalIndex();
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    const { getAccessIndex } = require('platform/src/accessIndex.ts');
    const { parseAccessRef } = require('business/src/accesses/refs.ts');
    const { localStorePrepareQuery, localStorePrepareOptions } = require('storage/src/localStoreEventQueries.ts');
    const { buildReport, renderMarkdown } = require('audit/src/breachScopeReport.ts');
    const { fromCallback } = require('utils');
    // Read the audit STORAGE directly from the barrel (set by storages.init).
    // We deliberately skip audit.init(): it also wires the syslog sink (a unix
    // dgram socket) which is irrelevant to a read-only tool and needs a socket
    // path this standalone process has no reason to configure. The active
    // filter config comes straight from config for the report preamble.
    const auditStorage = require('storages').auditStorage;
    if (auditStorage == null) throw new Error('audit storage is not available (is audit configured on this core?)');

    // 1. normalize the accessId (audit streams carry composite <base>:<serial>)
    let baseId = args.access;
    try { baseId = parseAccessRef(args.access).base; } catch (_e) { /* not composite — use as-is */ }
    trace('base accessId = ' + baseId);

    // 2. resolve accessId -> owner via the cluster-replicated reverse-index
    const entry = await getAccessIndex(platform, baseId);
    if (entry == null) {
      console.error('breach-scope: accessId "' + args.access + '" is not in the reverse-index.');
      console.error('  Check the id. If the access predates the index, run bin/backfill-access-index.js on each core.');
      process.exit(3);
    }
    if (entry.userDeleted === true) {
      console.error('breach-scope: the owning subject of "' + baseId + '" has been erased (tombstoned index row).');
      console.error('  This confirms the accessId belonged to a since-erased account:');
      console.error('  ' + JSON.stringify({ type: entry.type, created: entry.created, deleted: entry.deleted }));
      console.error('  Any retained audit lives on the home core under audit.onUserDelete: keep.');
      process.exit(5);
    }

    // 3. home-core check + hashed-mode plaintext recovery (local, never crosses cores)
    let username;
    let userId;
    const piiHashed = platform.piiModeIsHashed === true;
    if (!piiHashed && typeof entry.username === 'string') {
      username = entry.username;
      userId = await usersIndex.getUserId(username);
    } else if (typeof entry.usernameToken === 'string') {
      const byUsername = await usersIndex.getAllByUsername(); // { username: userId }
      for (const u of Object.keys(byUsername)) {
        if (platform.hashFor('username', u) === entry.usernameToken) { username = u; break; }
      }
      if (username != null) userId = await usersIndex.getUserId(username);
    } else if (typeof entry.username === 'string') {
      // cleartext row read while running hashed (mixed migration) — best effort
      username = entry.username;
      userId = await usersIndex.getUserId(username);
    }

    if (userId == null) {
      // not this core: resolve the home core and tell the operator where to run
      let coreUrl = null;
      try {
        const coreId = piiHashed && typeof entry.usernameToken === 'string'
          ? await platform.getUserCoreByPreHashedUsername(entry.usernameToken)
          : (username != null ? await platform.getUserCore(username) : null);
        coreUrl = coreId != null ? platform.coreIdToUrl(coreId) : null;
      } catch (_e) { /* resolution best-effort */ }
      console.error('breach-scope: this is not the subject\'s home core.');
      console.error('  Run this tool on: ' + (coreUrl || '(home core unresolvable — try each core)'));
      process.exit(4);
    }
    trace('resolved subject: ' + username + ' (' + userId + ')');

    // 4. authoritative access row from the home core (index was routing only)
    let accessRow = null;
    try {
      const accesses = await fromCallback((cb) =>
        storageLayer.accesses.findIncludingDeletionsAndVersions({ id: userId }, { headId: null }, null, cb));
      accessRow = (accesses || []).find((a) => a != null && a.id === baseId) || null;
    } catch (err) {
      trace('access-storage read failed (' + (err && err.message) + '); falling back to index metadata');
    }
    if (accessRow == null) trace('no authoritative access row; report will flag indexDivergence');

    // 5. pull the audit rows for this access over the window
    const sinceTs = args.sinceTs;
    const untilTs = args.untilTs;
    const userDB = await auditStorage.forUser(userId);
    const query = localStorePrepareQuery({ state: 'all', streams: [[{ any: ['access-' + baseId] }]], fromTime: sinceTs, toTime: untilTs });
    const options = localStorePrepareOptions({ sortAscending: true });
    const auditRows = await userDB.getEvents({ query, options });
    trace('audit rows in window: ' + (auditRows ? auditRows.length : 0));

    // 6. build the report (pure module)
    const meta = {
      generatedAt: new Date().toISOString(),
      toolName: 'breach-scope',
      toolVersion: readToolVersion(),
      coreUrl: config.get('core:url') || '(unset)',
      coreId: config.get('core:id') || 'single',
      piiMode: piiHashed ? 'hashed' : 'cleartext',
      username,
      userId,
      accessIdAsPasted: args.access,
      baseAccessId: baseId,
      since: args.since,
      until: args.until,
      sinceTs,
      untilTs,
      auditFilterConfig: {
        storage: config.get('audit:storage:filter') ?? null,
        syslog: config.get('audit:syslog:filter') ?? null
      }
    };
    const report = buildReport(auditRows || [], accessRow, entry, meta);

    // 6b. Best-effort stream-name resolution for LOCAL streams (the mall layer
    // maps stream ids -> names). Any failure or a since-deleted id degrades to
    // id-only with resolvedAtReportTime:false; resolution must NEVER fail the
    // report. Store-prefixed ids are left id-only (external stores).
    try {
      const localIds = report.dataCategories.streams.map((s) => s.id).filter((id) => !id.startsWith(':'));
      if (localIds.length > 0) {
        const { getMall } = require('mall');
        const mall = await getMall();
        const tree = await mall.streams.get(userId, { id: '*', storeId: 'local', childrenDepth: -1, includeTrashed: true, excludedIds: [] });
        const nameById = new Map();
        const stack = Array.isArray(tree) ? [...tree] : [];
        while (stack.length > 0) {
          const s = stack.pop();
          if (s == null) continue;
          if (typeof s.id === 'string') nameById.set(s.id, s.name ?? null);
          if (Array.isArray(s.children)) for (const c of s.children) stack.push(c);
        }
        let resolved = 0;
        for (const s of report.dataCategories.streams) {
          if (nameById.has(s.id)) { s.name = nameById.get(s.id); s.resolvedAtReportTime = true; resolved++; }
        }
        trace('resolved ' + resolved + '/' + localIds.length + ' local stream names');
      }
    } catch (err) {
      trace('stream-name resolution skipped (id-only): ' + (err && err.message));
    }

    // 7. render + emit.
    const fs = require('fs');
    for (const out of args.outputs) {
      const ext = path.extname(out).toLowerCase();
      if (ext === '.json') fs.writeFileSync(out, JSON.stringify(report, null, 2));
      else if (ext === '.md') fs.writeFileSync(out, renderMarkdown(report));
      else throw usageError('unknown output extension "' + ext + '" (use .json or .md): ' + out);
      trace('wrote ' + out);
    }
    if (args.outputs.length === 0) {
      // Flush stdout BEFORE exiting: process.exit() right after an async
      // stdout.write can truncate a piped report (e.g. `... --json | jq`).
      const text = (args.json ? JSON.stringify(report, null, 2) : renderMarkdown(report)) + '\n';
      process.stdout.write(text, () => process.exit(0));
      return;
    }
    process.exit(0);
  } catch (err) {
    if (err && err.usage) {
      console.error('breach-scope: ' + err.message);
      process.exit(2);
    }
    console.error('breach-scope: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function usageError (msg) {
  const e = new Error(msg);
  e.usage = true;
  return e;
}

function toPryvSeconds (iso, label) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw usageError('invalid ' + label + ' timestamp (expected ISO 8601): ' + iso);
  return ms / 1000;
}

function parseArgs (argv) {
  const args = { access: null, since: null, until: null, outputs: [], json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--access': args.access = argv[++i]; break;
      case '--since': args.since = argv[++i]; break;
      case '--until': args.until = argv[++i]; break;
      case '--output': args.outputs.push(argv[++i]); break;
      case '--json': args.json = true; break;
      case '--verbose': args.verbose = true; break;
      default: throw usageError('unknown option: ' + a);
    }
  }
  if (!args.access) throw usageError('--access <accessId> is required');
  if (!args.since) throw usageError('--since <iso8601> is required');
  args.sinceTs = toPryvSeconds(args.since, '--since');
  if (args.until) {
    args.untilTs = toPryvSeconds(args.until, '--until');
  } else {
    args.untilTs = Date.now() / 1000;
    args.until = new Date(args.untilTs * 1000).toISOString();
  }
  if (args.sinceTs >= args.untilTs) throw usageError('--since must be before --until');
  for (const out of args.outputs) {
    const ext = path.extname(out).toLowerCase();
    if (ext !== '.json' && ext !== '.md') throw usageError('output must end in .json or .md: ' + out);
  }
  return args;
}

function readToolVersion () {
  try { return require('../package.json').version || '0'; } catch (_e) { return '0'; }
}

function printUsage (stream) {
  stream.write([
    'Usage:',
    '  node bin/breach-scope.js --access <accessId> --since <iso8601> \\',
    '       [--until <iso8601>] [--output report.json] [--output report.md] \\',
    '       [--json] [--verbose]',
    '',
    'Scope a suspected breach from one compromised accessId over a time window.',
    'Read-only; run on the subject\'s home core (it prints where to run otherwise).',
    'Default output is Markdown to stdout; --json emits JSON to stdout; each',
    '--output writes a file (.json or .md by extension).',
    '',
    'Exit: 0 ok | 1 error | 2 usage | 3 not indexed | 4 wrong core | 5 subject erased',
    ''
  ].join('\n'));
}
