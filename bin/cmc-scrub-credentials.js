#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: remove access tokens left in CMC accept / refuse records
// written before the core started stripping them.
//
// What it targets. Accepting an invite writes a `consent/accept-cmc` event into
// the accepter's own `:_cmc:apps:<app-code>` stream, and older cores stored two
// working credentials in it: the data-grant endpoint under
// `acceptedBy.apiEndpoint` (a token to the accepter's own data) and the invite
// URL under `capabilityUrl`. An app can hold `read` on that stream, and an
// export of the account carries it, so those events hand out live credentials.
// `consent/refuse-cmc` records carry the same `capabilityUrl`.
//
// What it does. Rewrites each affected event's content with the tokens removed,
// keeping the rest of the URL (scheme, host, port, path) so the record still
// says WHICH endpoint it means. `dataGrantAccessId` and `content.from`, which
// is what the records are actually read for, are untouched.
//
// It does NOT touch:
//   - a trigger whose `content.status` is not 'completed'. A pending or failed
//     accept is re-dispatched from its `capabilityUrl`, so scrubbing it would
//     strand the retry. Re-run the tool once those have settled.
//   - the requester's own `consent/request-cmc` invite, whose `capabilityUrl`
//     IS the deliverable the app shares.
//   - the `:_cmc:_internal:*` subtree (retry queue, offers, responses), which
//     no API read path can reach.
//
// Every write passes `skipVersioning`, so the scrub does not archive the very
// content it is removing.
//
// Version rows: REPORTED, NOT REWRITTEN. On a core running with
// `versioning.forceKeepHistory`, a history row holds the content as it was
// before an update, so a record written before the fix can still have a
// credential in its history, reachable through
// `events.getOne?includeHistory=true`. There is no supported write path for
// those rows: the mall presents a version under its HEAD's id (see
// getHistory in the engines), so an update aimed at one would rewrite the head
// instead. Rather than appear to clean them, this tool counts them and names
// the events, leaving the operator to decide. A core with history off, which
// is the default, has none.
//
// Safe to re-run: an event with nothing left to remove is counted as clean and
// not rewritten.
//
// Usage:
//   node bin/cmc-scrub-credentials.js --dry-run   # report what would change
//   node bin/cmc-scrub-credentials.js             # rewrite
//   node bin/cmc-scrub-credentials.js --user <username>   # one account only
//
// Run once per core: it walks THIS core's local users.

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

// Multi-core joiners (e.g. a raw-deploy secondary core) carry their PG /
// storage-path config in a host-config file layered on top via `--config`,
// exactly as `bin/master.js` does. Load it here too so the scrub reads and
// writes the same authoritative storage the running core uses.
const configFileArg = (() => {
  const i = process.argv.indexOf('--config');
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
})();

require('@pryv/boiler').init({
  appName: 'cmc-scrub-credentials',
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

// The two record types that stored a credential, and the content paths that
// held one. `acceptedBy.apiEndpoint` is only ever on an accept.
const TARGET_TYPES = ['consent/accept-cmc', 'consent/refuse-cmc'];

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();

    await require('storages').init(config);
    const { getUsersLocalIndex } = require('storage');
    const { getMall } = require('mall');
    // hasCredential / scrubCredentials are the SAME definition the running
    // core applies when it completes a trigger, so this tool and the live
    // path cannot drift apart on what counts as a credential.
    const cmc = require('cmc');
    const { hasCredential, scrubCredentials } = cmc;

    const mall = await getMall();
    const usersIndex = await getUsersLocalIndex();

    const byUsername = await usersIndex.getAllByUsername(); // { username: userId }
    let usernames = Object.keys(byUsername);
    if (args.user != null) {
      if (byUsername[args.user] == null) {
        console.error('cmc-scrub-credentials: no such user on this core: ' + args.user);
        process.exit(1);
      }
      usernames = [args.user];
    }

    const counts = {
      users: usernames.length,
      seen: 0,
      scrubbed: 0,
      clean: 0,
      skippedUnsettled: 0,
    };
    // Events whose HISTORY still holds a credential (see the note at the top:
    // reported, not rewritten). Kept as `username/eventId` so the operator can
    // act on them.
    const dirtyHistory = [];

    for (const username of usernames) {
      const userId = byUsername[username];
      const events = await mall.events.get(userId, { types: TARGET_TYPES, limit: 1_000_000 });
      for (const event of (events || [])) {
        if (event == null || event.id == null) continue;
        // The requester's own invite keeps its capabilityUrl; only records in
        // the accepter's app scopes are in scope here. An event living in the
        // internal subtree is not reachable by any API read path anyway.
        const streamIds = Array.isArray(event.streamIds) ? event.streamIds : [];
        if (!streamIds.some((id) => typeof id === 'string' && id.startsWith(cmc.NS_APPS + ':'))) continue;
        counts.seen++;

        // A trigger that has not settled is still the retry queue's input.
        if (event.content?.status !== 'completed') {
          if (hasCredential(event.content)) counts.skippedUnsettled++;
          else counts.clean++;
          continue;
        }

        // History is checked whatever the head looks like: an already-clean
        // head can still have a dirty version behind it.
        const versions = mall.events.getHistory != null
          ? await mall.events.getHistory(userId, event.id)
          : [];
        const dirtyVersions = (versions || []).filter((v) => hasCredential(v?.content)).length;
        if (dirtyVersions > 0) {
          dirtyHistory.push(username + '/' + event.id + ' (' + dirtyVersions + ' version row(s))');
        }

        const cleaned = scrubCredentials(event.content);
        if (cleaned == null) { counts.clean++; continue; }
        counts.scrubbed++;
        if (args.dryRun) continue;

        await mall.events.update(userId, { ...event, content: cleaned }, null, { skipVersioning: true });
      }
    }

    console.log('cmc-scrub-credentials: ' + (args.dryRun ? 'DRY-RUN (no writes)' : 'rewrite'));
    console.log('  users scanned       ' + counts.users);
    console.log('  records seen        ' + counts.seen);
    console.log('  records scrubbed    ' + counts.scrubbed);
    console.log('  already clean       ' + counts.clean);
    console.log('  skipped (unsettled) ' + counts.skippedUnsettled);
    if (counts.skippedUnsettled > 0) {
      console.log('');
      console.log('  ' + counts.skippedUnsettled + ' record(s) still carry a credential because their');
      console.log('  orchestration has not settled; the retry queue re-dispatches from it.');
      console.log('  Re-run once they report status completed or failed.');
    }
    if (dirtyHistory.length > 0) {
      console.log('');
      console.log('  NOT CLEANED: ' + dirtyHistory.length + ' record(s) keep a credential in their');
      console.log('  VERSION HISTORY, which this tool cannot rewrite (no supported write path');
      console.log('  addresses a version row). They are reachable through');
      console.log('  events.getOne?includeHistory=true by an access holding read on the stream.');
      console.log('  Revoke the relationship to invalidate the token, or delete the record.');
      for (const entry of dirtyHistory) console.log('    ' + entry);
    }
    process.exit(0);
  } catch (err) {
    console.error('cmc-scrub-credentials: ' + ((err && err.stack) || err));
    process.exit(1);
  }
})();

function parseArgs (argv) {
  const args = { dryRun: false, user: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--user') { i++; args.user = argv[i]; } else if (a === '--config') { i++; /* file consumed by boiler at init */ } else {
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
    'Remove access tokens left in CMC accept / refuse records written before',
    'the core started stripping them.',
    '',
    'Usage:',
    '  node bin/cmc-scrub-credentials.js --dry-run        # report; do not write',
    '  node bin/cmc-scrub-credentials.js                  # rewrite',
    '  node bin/cmc-scrub-credentials.js --user <username>  # one account only',
    '',
    'On a multi-core joiner that layers a host-config file (PG host, storage',
    'paths) on top, pass it through so the scrub reads the same storage:',
    '  node bin/cmc-scrub-credentials.js --config config/host-config.yml',
    '',
    'Run once per core. Safe to re-run. Records whose orchestration has not',
    'settled are left alone (the retry queue re-dispatches from them) and',
    'reported, so re-run once those report completed or failed.',
    ''
  ].join('\n'));
}
