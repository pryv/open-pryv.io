#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: replace access credentials left in events' `modifiedBy` by
// high-frequency series ingest, and optionally revoke the accesses concerned.
//
// What it targets. Before this release, a write to a HF series recorded the
// request's authorization value (the access token, or "<token> <callerId>")
// as the series event's `modifiedBy`, instead of the access id. Any access
// allowed to read the event could read that value back.
//
// What it does. For each local user, it maps every access token of the user
// (live and deleted accesses) to its access id, then rewrites each event whose
// `modifiedBy` starts with such a token to the access id, keeping a caller-id
// suffix when there is one. Writes pass `skipVersioning` and go through the
// mall, which recomputes the event's integrity.
//
// With `--revoke`, every still-live access found that way is deleted the way
// `accesses.delete` deletes it (webhooks of the access, the access, its alias
// reservation, its breach-scope index row marked deleted) and its session
// destroyed: its token must be treated as disclosed to every access that could
// read those events. Accesses an app or shared access created are kept (their
// own tokens were not stored) and listed. Running cores keep accesses in an
// in-process cache: restart them after a revoke (the documented upgrade order
// runs this tool between the code update and the restart).
//
// Version rows: REPORTED, NOT REWRITTEN (no supported write path addresses a
// version row; see bin/cmc-scrub-credentials.js). A core with history off,
// the default, has none.
//
// Usage:
//   node bin/hfs-author-scrub.js --dry-run              # report only
//   node bin/hfs-author-scrub.js                        # rewrite
//   node bin/hfs-author-scrub.js --revoke               # rewrite + revoke the accesses concerned
//   node bin/hfs-author-scrub.js --user <username>      # one account only
//   node bin/hfs-author-scrub.js --config config/host-config.yml   # multi-core joiner
//
// Run once per core. Safe to re-run.

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
  appName: 'hfs-author-scrub',
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
    const { getUsersLocalIndex, getStorageLayer } = require('storage');
    const { getMall } = require('mall');
    const { fromCallback } = require('utils');
    const { authorFor } = require('hfs-server/src/author_scrub.ts');
    const WebhooksRepository = require('business').webhooks.Repository;
    const { getUsersRepository } = require('business/src/users/index.ts');
    const { getPlatform } = require('platform');
    const { markAccessDeletedInIndex } = require('platform/src/accessIndex.ts');
    const timestamp = require('unix-timestamp');

    const mall = await getMall();
    const usersIndex = await getUsersLocalIndex();
    const storageLayer = await getStorageLayer();
    const webhooksRepository = new WebhooksRepository(storageLayer.webhooks, storageLayer.events, storageLayer.accesses);
    const failures = [];

    // Same steps and order as `accesses.delete` (methods/accesses.ts), minus the
    // cascade to accesses this one created and the cache bust (restart instead).
    async function revokeAccess (user, accessId, token) {
      const row = await fromCallback((cb) => storageLayer.accesses.findOne(user, { id: accessId }, null, cb));
      if (row == null) return false;
      await webhooksRepository.deleteByAccess(user, accessId);
      await fromCallback((cb) => storageLayer.accesses.delete(user, { id: accessId }, cb));
      await fromCallback((cb) => storageLayer.sessions.destroy(token, cb));
      if (typeof row.alias === 'string') await (await getUsersRepository()).releaseAlias(row.alias);
      try {
        await markAccessDeletedInIndex(await getPlatform(), user.username, row, timestamp.now());
      } catch (err) {
        failures.push(user.username + ' access ' + accessId + ': index row not marked deleted (' + err.message + ')');
      }
      return true;
    }

    async function createdAccessesCount (user, accessId) {
      const created = await fromCallback((cb) => storageLayer.accesses.find(user, { createdBy: accessId }, null, cb));
      return (created || []).filter((a) => a.id !== accessId).length;
    }

    const byUsername = await usersIndex.getAllByUsername(); // { username: userId }
    let usernames = Object.keys(byUsername);
    if (args.user != null) {
      if (byUsername[args.user] == null) {
        console.error('hfs-author-scrub: no such user on this core: ' + args.user);
        process.exit(1);
      }
      usernames = [args.user];
    }

    const counts = { users: usernames.length, rewritten: 0, accessesConcerned: 0, accessesRevoked: 0 };
    const concerned = []; // { username, accessId, type, live }
    const dirtyHistory = [];

    for (const username of usernames) {
      const userId = byUsername[username];
      const user = { id: userId, username };
      const live = await fromCallback((cb) => storageLayer.accesses.find(user, {}, null, cb));
      const deleted = await fromCallback((cb) => storageLayer.accesses.findDeletions(user, 0, null, cb));
      const byToken = new Map(); // token -> { id, type, live }
      const ids = new Set();
      for (const a of (live || [])) {
        if (a?.id == null) continue;
        ids.add(a.id);
        if (typeof a.token === 'string' && a.token !== '') byToken.set(a.token, { id: a.id, type: a.type, live: true, token: a.token });
      }
      for (const a of (deleted || [])) {
        if (a?.id == null) continue;
        ids.add(a.id);
        if (typeof a.token === 'string' && a.token !== '' && !byToken.has(a.token)) byToken.set(a.token, { id: a.id, type: a.type, live: false, token: a.token });
      }
      if (byToken.size === 0) continue;

      const events = await mall.events.get(userId, { state: 'all', limit: 1_000_000 });
      const hitAccesses = new Map();
      for (const event of (events || [])) {
        const rewritten = authorFor(event?.modifiedBy, byToken, ids);
        if (rewritten == null) continue;
        hitAccesses.set(rewritten.access.id, rewritten.access);
        if (mall.events.getHistory != null) {
          const versions = await mall.events.getHistory(userId, event.id);
          const dirty = (versions || []).filter((v) => authorFor(v?.modifiedBy, byToken, ids) != null).length;
          if (dirty > 0) dirtyHistory.push(username + '/' + event.id + ' (' + dirty + ' version row(s))');
        }
        counts.rewritten++;
        if (args.dryRun) continue;
        await mall.events.update(userId, { ...event, modifiedBy: rewritten.value }, null, { skipVersioning: true });
      }

      for (const access of hitAccesses.values()) {
        counts.accessesConcerned++;
        const entry = { username, accessId: access.id, type: access.type, live: access.live, created: 0 };
        concerned.push(entry);
        if (access.live && access.type !== 'personal') entry.created = await createdAccessesCount(user, access.id);
        if (!args.revoke || !access.live || args.dryRun) continue;
        if (await revokeAccess(user, access.id, access.token)) counts.accessesRevoked++;
      }
    }

    console.log('hfs-author-scrub: ' + (args.dryRun ? 'DRY-RUN (no writes)' : (args.revoke ? 'rewrite + revoke' : 'rewrite')));
    console.log('  users scanned        ' + counts.users);
    console.log('  events rewritten     ' + counts.rewritten + (args.dryRun ? ' (would be)' : ''));
    console.log('  accesses concerned   ' + counts.accessesConcerned);
    console.log('  accesses revoked     ' + counts.accessesRevoked);
    for (const c of concerned) {
      console.log('    ' + c.username + ' access ' + c.accessId + ' (' + c.type + ', ' + (c.live ? 'live' : 'already deleted') + ')' +
        (c.created > 0 ? '; ' + c.created + ' access(es) it created are kept' : ''));
    }
    if (counts.accessesRevoked > 0) {
      console.log('');
      console.log('  Restart the core so its workers drop the revoked accesses from their cache.');
    } else if (concerned.some((c) => c.live) && !args.revoke) {
      console.log('');
      console.log('  Live accesses listed above: their tokens were readable by other accesses.');
      console.log('  Re-run with --revoke (then restart) to delete them and close their sessions.');
    }
    if (dirtyHistory.length > 0) {
      console.log('');
      console.log('  NOT CLEANED: ' + dirtyHistory.length + ' event(s) keep a credential in their VERSION');
      console.log('  HISTORY (no supported write path addresses a version row). Revoke the access.');
      for (const entry of dirtyHistory) console.log('    ' + entry);
    }
    if (failures.length > 0) {
      console.log('');
      console.log('  FAILED: ' + failures.length + ' revoked access(es) not marked deleted in the access index:');
      for (const f of failures) console.log('    ' + f);
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('hfs-author-scrub: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function parseArgs (argv) {
  const args = { dryRun: false, revoke: false, user: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--revoke') args.revoke = true;
    else if (a === '--user') { i++; args.user = argv[i]; } else if (a === '--config') { i++; /* consumed by boiler at init */ } else {
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
    'Replace access credentials left in events\' modifiedBy by high-frequency series',
    'ingest with the access id, and optionally revoke the accesses concerned.',
    '',
    'Usage:',
    '  node bin/hfs-author-scrub.js --dry-run            # report; do not write',
    '  node bin/hfs-author-scrub.js                      # rewrite',
    '  node bin/hfs-author-scrub.js --revoke             # rewrite and revoke (then restart the core)',
    '  node bin/hfs-author-scrub.js --user <username>    # one account only',
    '',
    'On a multi-core joiner that layers a host-config file on top, pass it through:',
    '  node bin/hfs-author-scrub.js --config config/host-config.yml',
    '',
    'Run once per core. Safe to re-run.',
    ''
  ].join('\n'));
}
