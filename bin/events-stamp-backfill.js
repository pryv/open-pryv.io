#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: fill the tracking properties (`created`, `createdBy`,
// `modified`, `modifiedBy`) of events stored without them.
//
// What it targets. Before this release, events the platform writes itself
// (consent inbox copies and scope-update records, retry and offer records,
// delegation records, account e-mail records) were stored without some or all
// of these four properties. `events.get` returned them without fields the
// Event schema documents as always present, and the `modifiedSince` filter
// never returned them.
//
// What it does. For each local user, it reads the events missing any of the
// four properties a page at a time (keyset on the event id, `--page-size`)
// and rewrites each one:
//   created    = created, else the event's `time`, else its old `modified`
//                (never later than the run time)
//   createdBy  = createdBy, else `system`
//   modified   = the time of the rewrite (a repaired event is returned once by
//                the next `modifiedSince` sync of each client)
//   modifiedBy = modifiedBy, else `system`
// `system` is the platform's reserved access id, never the id of a real
// access. Trashed events are included. Deleted events are not: the deletion
// modes clear these properties on purpose. Writes pass `skipVersioning` and go
// through the mall, which recomputes the event's integrity.
//
// Version rows: REPORTED, NOT REWRITTEN (no supported write path addresses a
// version row; see bin/cmc-scrub-credentials.js). A core with history off,
// the default, has none.
//
// Usage:
//   node bin/events-stamp-backfill.js --dry-run              # report only
//   node bin/events-stamp-backfill.js                        # rewrite
//   node bin/events-stamp-backfill.js --user <username>      # one account only
//   node bin/events-stamp-backfill.js --page-size <n>        # events read per query (default 1000)
//   node bin/events-stamp-backfill.js --config config/host-config.yml   # multi-core joiner
//
// Run once per core. Safe to re-run. No restart needed.

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

const configFileArg = (() => {
  const i = process.argv.indexOf('--config');
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
})();
if (process.argv.includes('--config') &&
    (configFileArg == null || configFileArg.startsWith('-') ||
     !require('fs').existsSync(path.resolve(process.cwd(), configFileArg)))) {
  console.error(`--config: file not found: ${configFileArg ?? '(missing <file>)'}`);
  process.exit(1);
}

require('@pryv/boiler').init({
  appName: 'events-stamp-backfill',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../config/plugins/systemStreams')
  }, {
    plugin: require('../config/plugins/core-identity')
  }, ...(configFileArg != null
    ? [{ scope: 'host-config', file: path.resolve(process.cwd(), configFileArg) }]
    : [])]
});

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();

    await require('storages').init(config);
    const { getUsersLocalIndex } = require('storage');
    const { getMall, storeDataUtils } = require('mall');
    const { convertEventFromStore } = require('mall/src/helpers/eventsUtils.ts');
    const { pagedRows } = require('hfs-server/src/author_scrub.ts');
    const { SystemAccessId } = require('@pryv/datastore').defaults;

    const mall = await getMall();
    const localStoreId = storeDataUtils.LocalStoreId;
    const localEvents = mall.events.eventsStores.get(localStoreId);
    if (typeof localEvents?._getUnstampedPage !== 'function' ||
        typeof localEvents?._countUnstampedVersionRows !== 'function') {
      throw new Error('the local events store of this core cannot list events without tracking properties');
    }
    const usersIndex = await getUsersLocalIndex();

    const byUsername = await usersIndex.getAllByUsername(); // { username: userId }
    let usernames = Object.keys(byUsername);
    if (args.user != null) {
      if (byUsername[args.user] == null) {
        console.error('events-stamp-backfill: no such user on this core: ' + args.user);
        process.exit(1);
      }
      usernames = [args.user];
    }

    const counts = { users: usernames.length, rewritten: 0, versionRows: 0 };
    const perUser = []; // { username, rewritten, versionRows }

    for (const username of usernames) {
      const userId = byUsername[username];
      let rewritten = 0;
      const rows = pagedRows((afterId, limit) => localEvents._getUnstampedPage(userId, afterId, limit), args.pageSize);
      for await (const storeEvent of rows) {
        rewritten++;
        if (args.dryRun) continue;
        const event = convertEventFromStore(localStoreId, storeEvent);
        await mall.events.update(userId, stamped(event, Date.now() / 1000, SystemAccessId), null, { skipVersioning: true });
      }
      const versionRows = await localEvents._countUnstampedVersionRows(userId);
      counts.rewritten += rewritten;
      counts.versionRows += versionRows;
      if (rewritten > 0 || versionRows > 0) perUser.push({ username, rewritten, versionRows });
    }

    console.log('events-stamp-backfill: ' + (args.dryRun ? 'DRY-RUN (no writes)' : 'rewrite'));
    console.log('  users scanned        ' + counts.users);
    console.log('  events rewritten     ' + counts.rewritten + (args.dryRun ? ' (would be)' : ''));
    console.log('  version rows with NULL stamps (not rewritten)   ' + counts.versionRows);
    for (const u of perUser) {
      console.log('    ' + u.username + ': ' + u.rewritten + ' event(s)' +
        (u.versionRows > 0 ? ', ' + u.versionRows + ' version row(s)' : ''));
    }
    process.exit(0);
  } catch (err) {
    console.error('events-stamp-backfill: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

/**
 * The event with its missing tracking properties filled and `modified` set
 * to `now` (see the header for the rules).
 */
function stamped (event, now, systemAccessId) {
  let created = event.created;
  if (typeof created !== 'number') {
    created = typeof event.time === 'number' ? event.time : event.modified;
    if (typeof created !== 'number' || created > now) created = now;
  }
  return {
    ...event,
    created,
    createdBy: event.createdBy ?? systemAccessId,
    modified: now,
    modifiedBy: event.modifiedBy ?? systemAccessId
  };
}

function parseArgs (argv) {
  const args = { dryRun: false, user: null, pageSize: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--user') { i++; args.user = argv[i]; } else if (a === '--page-size') {
      i++;
      args.pageSize = /^[1-9][0-9]*$/.test(argv[i] ?? '') ? Number(argv[i]) : NaN;
      if (!Number.isSafeInteger(args.pageSize)) {
        console.error('--page-size needs a positive integer');
        process.exit(1);
      }
    } else if (a === '--config') { i++; /* consumed by boiler at init */ } else {
      console.error('Unknown option: ' + a);
      process.exit(1);
    }
  }
  if (args.user != null && args.user.length === 0) {
    console.error('--user needs a username');
    process.exit(1);
  }
  return args;
}

function printUsage (stream) {
  stream.write([
    'Fill the tracking properties (created, createdBy, modified, modifiedBy) of',
    'events stored without them; `system` stands for the platform as author.',
    '',
    'Usage:',
    '  node bin/events-stamp-backfill.js --dry-run            # report; do not write',
    '  node bin/events-stamp-backfill.js                      # rewrite',
    '  node bin/events-stamp-backfill.js --user <username>    # one account only',
    '  node bin/events-stamp-backfill.js --page-size <n>      # events read per query (default 1000)',
    '',
    'Trashed events are rewritten too; deleted events and version rows are not',
    '(version rows are counted).',
    '',
    'On a multi-core joiner that layers a host-config file on top, pass it through:',
    '  node bin/events-stamp-backfill.js --config config/host-config.yml',
    '',
    'Run once per core. Safe to re-run.',
    ''
  ].join('\n'));
}
