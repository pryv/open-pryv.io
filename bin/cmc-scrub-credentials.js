#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Operator tool: remove access tokens left in CMC accept / refuse /
// back-channel records written before the core started stripping them.
//
// What it targets. Older cores stored working credentials in three places, all
// of them app-readable and all of them included in an account export:
//   - `consent/accept-cmc` in the accepter's own `:_cmc:apps:<app-code>`:
//     the data-grant endpoint under `acceptedBy.apiEndpoint`, a token to the
//     accepter's OWN data, and the invite URL under `capabilityUrl`.
//   - `consent/refuse-cmc` in the same place: the same `capabilityUrl`.
//   - `consent/back-channel-cmc`, peer-delivered into `:_cmc:inbox`, which apps
//     poll by design: `apiEndpoint`, the COUNTERPARTY's back-channel token. The
//     handler copies it onto the data-grant access's clientData, which is the
//     copy everything actually uses, and never removed it from the event.
//
// What it does. Rewrites each affected event's content with the tokens removed,
// keeping the rest of the URL (scheme, host, port, path) so the record still
// says WHICH endpoint it means. `dataGrantAccessId` and `content.from`, which
// is what the records are actually read for, are untouched.
//
// It covers settled records, 'completed' AND 'failed'. A failed one matters:
// a failed single-use accept leaves the requester's capability unconsumed, so
// the invite URL stored on it is still LIVE.
//
// A record carrying NO status was never stamped by any dispatch, so nothing is
// coming back for it: it is rewritten too, and counted separately.
//
// It does NOT touch:
//   - a trigger still mid-flight ('pending' / 'delivered'), because a live
//     dispatch may be working on it. Those are reported so a later run can
//     sweep them once they settle.
//   - the requester's own `consent/request-cmc` invite, whose `capabilityUrl`
//     IS the deliverable the app shares.
//   - the `:_cmc:_internal:*` subtree (retry queue, offers, responses), which
//     no API read path can reach. The retry queue's own snapshot of a
//     trigger's content keeps its token there by design: `processRetryEvent`
//     re-dispatches from that snapshot, never from the stored trigger.
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

// The record types that stored a credential. accept and refuse live in the
// user's own `:_cmc:apps:*` scope; back-channel is peer-delivered into
// `:_cmc:inbox`, which apps poll by design, and held the COUNTERPARTY's
// back-channel token.
const TARGET_TYPES = [
  'consent/accept-cmc',
  'consent/refuse-cmc',
  'consent/back-channel-cmc',
];

// A record is safe to rewrite once its orchestration has stopped. Both of
// these are terminal for the stored trigger: the retry path works off its own
// snapshot in the internal retries stream, not off this row.
const SETTLED = new Set(['completed', 'failed']);

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
      noStatus: 0,
    };
    // Events whose HISTORY still holds a credential (see the note at the top:
    // reported, not rewritten). Kept as `username/eventId` so the operator can
    // act on them.
    const dirtyHistory = [];

    for (const username of usernames) {
      const userId = byUsername[username];
      // `state: 'all'` because the default excludes trashed events, and a
      // trashed record still holds its token, is still readable by an access
      // with `state=all`, and is still in the account backup's export.
      const events = await mall.events.get(userId, {
        types: TARGET_TYPES,
        state: 'all',
        limit: 1_000_000,
      });
      for (const event of (events || [])) {
        if (event == null || event.id == null) continue;
        // In scope: the app scopes (`:_cmc:apps:*`, where accept and refuse
        // records live) and `:_cmc:inbox` (where a peer-delivered back-channel
        // lands). Both are app-readable and both are in an account export. The
        // requester's own invite keeps its capabilityUrl and is a different
        // type anyway, and an event in the internal subtree is unreachable by
        // any API read path.
        const streamIds = Array.isArray(event.streamIds) ? event.streamIds : [];
        const inScope = streamIds.some((id) => typeof id === 'string' &&
          (id.startsWith(cmc.NS_APPS + ':') || id === cmc.NS_INBOX));
        if (!inScope) continue;
        counts.seen++;

        // A record with NO status at all was never stamped: either its
        // dispatch could not write (the loop logs and moves on) or nothing
        // dispatched it. Nothing is coming back for it, so waiting for it to
        // "settle" would skip it forever. Treat it as settled, and count it
        // separately so the operator sees it happened.
        const status = event.content?.status;
        if (status == null) {
          if (hasCredential(event.content)) counts.noStatus++;
        } else if (!SETTLED.has(status)) {
          // Still mid-flight: a live dispatch may be working on it.
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
    if (counts.noStatus > 0) {
      console.log('  scrubbed (no status) ' + counts.noStatus +
        '  (never stamped by any dispatch; nothing was coming back for them)');
    }
    if (counts.skippedUnsettled > 0) {
      console.log('');
      console.log('  ' + counts.skippedUnsettled + ' record(s) still carry a credential and are still');
      console.log('  mid-flight (pending / delivered), so a live dispatch may be working on them.');
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
    'Covers consent/accept-cmc and consent/refuse-cmc in the user\'s own',
    ':_cmc:apps:* scopes, and consent/back-channel-cmc delivered to :_cmc:inbox.',
    '',
    'On a multi-core joiner that layers a host-config file (PG host, storage',
    'paths) on top, pass it through so the scrub reads the same storage:',
    '  node bin/cmc-scrub-credentials.js --config config/host-config.yml',
    '',
    'Run once per core. Safe to re-run. Covers settled records (completed and',
    'failed); one still mid-flight is left alone and reported, so re-run once',
    'those settle.',
    ''
  ].join('\n'));
}
