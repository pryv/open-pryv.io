#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Master process: manages API, HFS, and Previews workers via Node.js cluster module.
// Replaces runit-based multi-process orchestration.
//
// Usage:
//   node bin/master.js [--config <path>]
//   node bin/master.js --bootstrap <bundle-file> --bootstrap-passphrase-file <path>
//                      [--bootstrap-tls-dir <path>] [--bootstrap-config-dir <path>]
//                      [--bootstrap-ack-trust-system-ca] [--bootstrap-as-voter]
//                      [--bootstrap-clock-skew-seconds <n>] [--bootstrap-force]
//
// --bootstrap-clock-skew-seconds: before the ack, compare this host's clock
//   with the issuing core's and refuse the join (exit 1, join token not used)
//   when they differ by more than <n> seconds. Default 30; 0 disables.
//
// --bootstrap-ack-trust-system-ca: verify the ack POST against the system CA
//   store instead of pinning the cluster CA. Needed when the existing core's
//   API origin is fronted by a public/ACME cert (the normal internet-facing
//   case). The one-shot join token remains the authenticator.
//
// Join role: a joining core defaults to a NON-VOTER (safe by default). It
//   replicates the platform DB and forwards writes to the leader, but never
//   counts toward Raft quorum — so it cannot stall the cluster if it becomes
//   unreachable. Pass --bootstrap-as-voter to join as a voter instead; only do
//   this when building a >=3-voter HA cluster (two voters give a fragile 2-of-2
//   quorum where either core dying is an outage).
//
// In --bootstrap mode the master decrypts the bundle, stages
// `bootstrap-config.yml` + TLS files, posts an ack to the issuing core, moves
// the staged files into place once the ack is accepted (removes them on any
// failure), then falls through into normal startup — picking up the
// freshly-written config via @pryv/boiler's highest-precedence override-file slot.
//
// Config keys:
//   cluster.apiWorkers      — number of API workers (default: 2)
//   cluster.hfsWorkers      — number of HFS workers (default: 1, 0 = disabled)
//   cluster.previewsWorker  — enable previews worker (default: true)
//   migrations.autoRunOnStart — run pending DB migrations before forking workers (default: true)

const cluster = require('node:cluster');
const path = require('node:path');

const BASE_CONFIG_DIR = path.resolve(__dirname, '../config/');
const DEFAULT_TLS_DIR = '/etc/pryv/tls';

if (cluster.isPrimary) {
  const os = require('node:os');

  (async () => {
    // BOOTSTRAP MODE — runs before @pryv/boiler.init so the
    // bootstrap-config.yml it writes is picked up (below the operator's
    // override-config.yml) by the init below. Workers (cluster.fork()) skip this block entirely.
    const bootstrapArgs = parseBootstrapArgs(process.argv.slice(2));
    if (bootstrapArgs.enabled) {
      try {
        await runBootstrap(bootstrapArgs);
      } catch (err) {
        console.error('[bootstrap] FAILED: ' + err.message);
        if (process.env.DEBUG) console.error(err.stack);
        process.exit(1);
      }
    }

    // Minimal boiler init — just enough to read config (now including any
    // bootstrap-config.yml the bootstrap step wrote above).
    require('@pryv/boiler').init({
      appName: 'master',
      baseFilesDir: path.resolve(__dirname, '../'),
      baseConfigDir: BASE_CONFIG_DIR,
      extraConfigs: [{
        pluginAsync: require('../config/plugins/systemStreams')
      }, {
        plugin: require('../config/plugins/core-identity')
      }, {
        // `service.*` comes from `serviceInfoUrl` on any deployment that does
        // not spell it out in YAML. Master validates those fields below, so it
        // has to fetch them the same way the api-server does — otherwise it
        // reports the whole block missing and refuses to start.
        scope: 'serviceInfo',
        key: 'service',
        urlFromKey: 'serviceInfoUrl'
      }, {
        // Resolves the `REPLACE ME` path sentinels that `default-config.yml`
        // ships for the sqlite / filesystem / custom-extension directories.
        // The api-server registers this too; without it master judges those
        // sentinels unreplaced and refuses to start on a stock checkout.
        scope: 'default-paths',
        file: path.resolve(__dirname, '../config/plugins/paths-config.js')
      }, {
        // Fail master startup if required service fields are missing so
        // operators see the problem immediately rather than through
        // api-server worker crash loops.
        //
        // pluginAsync (not plugin), and registered AFTER the serviceInfo fetch
        // above, for two reasons. Sync `plugin` loads run inside boiler's
        // initSync BEFORE it loads `default-config.yml` and applies its own
        // defaults, so a sync validator judges a half-built config and reports
        // keys as missing that the defaults would have supplied. Async ones
        // drain afterwards, in registration order, so this sees the complete
        // config — defaults, serviceInfo and all. The api-server carries the
        // same note at its own registration site.
        pluginAsync: require('../config/plugins/config-validation')
      }]
    });

    const { getConfig, getLogger } = require('@pryv/boiler');
    const rqliteProcess = require('../storages/engines/rqlite/src/rqliteProcess.ts');

    const config = await getConfig();
    const logger = getLogger('master');
    // Through the logger only: its console (or, with no log target at all,
    // its stderr fallback for warnings and errors) reaches the journal.
    const log = (msg) => logger.info(msg);
    const warn = (msg) => logger.warn(msg);
    const error = (msg) => logger.error(msg);

    // engines.node is advisory only (npm does not enforce it), so a native host
    // held on an older Node would run on silently. Below 24.22.1 the runtime
    // lacks the Node.js security fixes of 2026-10-21 (Brotli decoder, TLS
    // hostname checks) and 24.19 to 24.21 abort on SQLite statement GC.
    const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split('.').map(Number);
    if (nodeMajor < 24 || (nodeMajor === 24 && (nodeMinor < 22 || (nodeMinor === 22 && nodePatch < 1)))) {
      warn(`Node.js ${process.version} is below 24.22.1, the minimum this release supports ` +
        '(security fixes of 2026-10-21): upgrade Node and run `npm rebuild`, see INSTALL.md "Node major bumps".');
    }

    // Start rqlited when rqlite is the platform engine — master.js owns the lifecycle.
    // When `storages.engines.rqlite.external` is true, skip spawning and connect to an
    // already-running instance (useful for multi-core deployments sharing one rqlited).
    // With `storages.platform.engine: postgresql` (single-core diskless shape)
    // no rqlited runs at all — platform data lives in PostgreSQL.
    const platformEngine = config.get('storages:platform:engine') || 'rqlite';
    if (platformEngine === 'rqlite') {
      const rqliteConfig = config.get('storages:engines:rqlite') || {};
      const httpPort = new URL(rqliteConfig.url || 'http://localhost:4001').port || 4001;
      if (rqliteConfig.external) {
        log(`Connecting to external rqlited at ${rqliteConfig.url || 'http://localhost:4001'}`);
        await rqliteProcess.waitForExternal(rqliteConfig.url || 'http://localhost:4001', rqliteConfig.readyTimeoutMs, log, warn);
      } else {
        await rqliteProcess.start({
          coreId: config.get('core:id') || 'single',
          binPath: rqliteConfig.binPath || 'bin-ext/rqlited',
          dataDir: rqliteConfig.dataDir || 'var-pryv/rqlite-data',
          httpPort: parseInt(httpPort),
          raftPort: rqliteConfig.raftPort || 4002,
          dnsDomain: config.get('dns:domain') || null,
          // rqlited DNS-based peer discovery is opt-in. Multi-core deploys
          // set `cluster.discoveryEnabled: true`; single-core deploys leave
          // it false even when `dns.domain` is set, otherwise rqlited boots
          // into a 30 s timeout looking for peers via the embedded DNS that
          // hasn't started yet (it's started further down in this same file).
          discoveryEnabled: config.get('cluster:discoveryEnabled') === true,
          // A non-voter core replicates the platform DB and forwards writes
          // to the leader but never counts toward quorum — so it cannot stall
          // the cluster if it goes unreachable. Recommended for the extra
          // cores of a 2-core deployment (keeps the first core a 1-of-1
          // quorum). Promote to voter only at >=3 cores.
          nonVoter: config.get('core:nonVoter') === true,
          coreIp: config.get('core:ip') || null,
          // The HTTP API listens on loopback unless explicitly bound elsewhere.
          httpBindAddr: rqliteConfig.httpBindAddr || null,
          tls: rqliteConfig.tls || null,
          // How long to wait for rqlited's HTTP API at boot. Nodes with a
          // large platform dataset or slow disks can need more than the
          // default; the boot fails (and the supervisor restarts the
          // container) when this budget is exceeded.
          readyTimeoutMs: rqliteConfig.readyTimeoutMs,
          // rqlited writes to the master's stdout / stderr, or appends to
          // this file when set; never to pipes the master reads.
          logFile: rqliteConfig.logFile || null,
          log,
          warn
        });
      }
    } else {
      log(`Platform engine '${platformEngine}' — not starting rqlited`);
    }

    // Initialise the storages barrel once, unconditionally. Every
    // downstream step (migrations, DNS server, Let's Encrypt,
    // observability) gets platform/DB handles via `require('storages')`
    // and must not be ordering-dependent on any optional block.
    await require('../storages/index.ts').init(config);

    // Platform DB integrity, this core's copy, read-only: a corrupted
    // primary-key index raises no error by itself (upserts duplicate keys,
    // lookups miss rows), so say it loudly at boot. Never blocks the boot.
    // Repeated periodically below (platformIntegrityMonitor).
    let bootIntegrityOk = null;
    try {
      const { describePlatformIntegrity } = require('../storages/interfaces/platformStorage/PlatformDB.ts');
      const report = await require('../storages/index.ts').platformDB.checkStoreIntegrity();
      bootIntegrityOk = report.ok;
      if (!report.ok) {
        error(`[platform-integrity] ${describePlatformIntegrity(report).join('\n  ')}`);
      }
    } catch (e) {
      warn(`[platform-integrity] check failed: ${e.message}`);
    }

    // Run pending schema migrations before starting services.
    // Each migration-capable engine (see storages/interfaces/migrations/) gets
    // its pending up() calls applied in filename order; version bumps persist
    // in that engine's schema_migrations tracking row/table.
    //
    // When `migrations.autoRunOnStart` is false the runner is still consulted
    // via `status()` so a loud WARNING surfaces any pending migrations — the
    // silent-skip footgun took down a demo deploy on 2026-05-13.
    const autoRunMigrations = config.get('migrations:autoRunOnStart') ?? true;
    const { createMigrationRunner, applyOrAnnounce } = require('../storages/interfaces/migrations/index.ts');
    const migrationRunner = await createMigrationRunner({ logger: getLogger('migrations') });
    await applyOrAnnounce({
      runner: migrationRunner,
      logger: { info: log, warn },
      autoRun: autoRunMigrations
    });

    // OAuth refresh tokens used to be stored with the raw token in the
    // platform-store key (replicated to every core). Move THIS core's rows to
    // hashed keys before workers serve /oauth2/token. Idempotent; a failure
    // is logged and retried at next boot (the legacy rows are then unusable
    // for refresh, so their clients re-authorize).
    try {
      const { rekeyLegacyRefreshTokens } = require('../components/oauth2/src/storage.ts');
      const moved = await rekeyLegacyRefreshTokens(
        require('../storages/index.ts').platformDB, String(config.get('core:id') ?? 'single'));
      if (moved > 0) log(`[oauth-refresh-rekey] moved ${moved} refresh-token row(s) to hashed keys`);
    } catch (e) {
      warn(`[oauth-refresh-rekey] failed: ${e.message}`);
    }

    // Refresh rows and consumed markers written before the username was
    // dropped from them still carry it: remove it from THIS core's rows, after
    // the re-key above and before workers serve /oauth2/token (a rewrite racing
    // a rotation would resurrect the consumed row). Idempotent; a failure is
    // logged and retried at next boot (rotation also rewrites rows without it).
    try {
      const { scrubUsernameFromRows } = require('../components/oauth2/src/storage.ts');
      const scrubbed = await scrubUsernameFromRows(
        require('../storages/index.ts').platformDB, String(config.get('core:id') ?? 'single'));
      if (scrubbed > 0) log(`[oauth-username-scrub] removed the username from ${scrubbed} refresh row(s)`);
    } catch (e) {
      warn(`[oauth-username-scrub] failed: ${e.message}`);
    }

    // OAuth client rows written before they carried `accountUserId` store the
    // app account's username: convert the rows of the accounts THIS core hosts
    // (the only core that resolves them, and the only one that can serve their
    // client_credentials grant). Before workers start; idempotent; a failure is
    // logged and retried at next boot (the grant still reads the old shape).
    try {
      const { migrateClientAccountIds } = require('../components/oauth2/src/storage.ts');
      const storagesBarrel = require('../storages/index.ts');
      const converted = await migrateClientAccountIds(storagesBarrel.platformDB,
        async (username) => (await storagesBarrel.usersLocalIndex.getUserId(username)) ?? null);
      if (converted > 0) log(`[oauth-client-account-migrate] converted ${converted} client row(s) to the account user id`);
    } catch (e) {
      warn(`[oauth-client-account-migrate] failed: ${e.message}`);
    }

    // --- Hosted sites boot check ---
    // A site this core cannot serve stops the boot before the platform
    // registration advertises it (the embedded DNS answers a site name with the
    // cores that advertise it). The folders are checked first, without the
    // database; then no core id and no existing user may be a site name. The
    // api workers repeat the checks before they listen.
    {
      const { parseHostedSites } = require('../components/business/src/hostedSites.ts');
      const sites = parseHostedSites(config);
      if (sites.size > 0) {
        const { checkStaticSiteFolders, checkHostedSitesAtBoot } = require('../components/api-server/src/hostedSitesIngress.ts');
        let problems = checkStaticSiteFolders(sites);
        if (problems.length === 0) {
          const { getUsersRepository } = require('../components/business/src/users/index.ts');
          const { getPlatform } = require('../components/platform/src/index.ts');
          problems = await checkHostedSitesAtBoot(sites, await getUsersRepository(), await getPlatform());
        }
        if (problems.length > 0) {
          for (const p of problems) error('[hosted-sites] ' + p);
          throw new Error('hosted sites configuration is invalid (see above)');
        }
        for (const site of sites.values()) {
          log(`[hosted-sites] ${site.name}: ${site.kind === 'static' ? 'static ' + site.root : 'proxy ' + site.upstream}`);
        }
      }
    }

    // --- Mail template seed ---
    // First-boot bootstrap: when `services.email.method === 'in-process'`,
    // populate PlatformDB from a Pug directory if it holds no templates yet.
    // Idempotent — subsequent boots are a no-op (the admin CLI / admin API
    // own the edit path).
    if (config.get('services:email:method') === 'in-process') {
      try {
        const platformDB = require('../storages/index.ts').platformDB;
        const { seedIfEmpty } = require('../components/mail/src/TemplateSeeder.ts');
        // Empty `templatesRootDir` means "the template set bundled with the mail component".
        const bundledTemplatesDir = path.resolve(__dirname, '../components/mail/templates');
        const templatesRootDir = config.get('services:email:templatesRootDir') || bundledTemplatesDir;
        const result = await seedIfEmpty({ platformDB, templatesRootDir });
        if (result.seeded) log(`Mail templates seeded (${result.count} row(s) from ${templatesRootDir})`);
        // Stored templates outside the allowed Pug subset are skipped when
        // mail is sent; say so at boot rather than at the first send.
        const { validateMailTemplate, describe } = require('../components/mail/src/templateValidator.ts');
        for (const row of await platformDB.getAllMailTemplates()) {
          const { ok, problems } = validateMailTemplate(row);
          if (!ok) warn(`mail template ${describe(row)} is not used: ${problems.join('; ')} (fix it with bin/mail.js templates set; list them with bin/mail.js templates validate)`);
        }
        // The registration gate mails a code on every sign-up. If an operator
        // deleted that template through the CLI, every registration would fail
        // at delivery time with nothing pointing at the cause.
        if (config.get('account:emailVerification:requireAtRegistration') === true) {
          const type = config.get('services:email:emailChallengeTemplate') || 'email-challenge';
          const lang = config.get('services:email:defaultLang') || 'en';
          if ((await platformDB.getMailTemplate(type, lang, 'html')) == null) {
            warn(`registration email gate is on but mail template ${type}/${lang}/html is missing from PlatformDB; every registration will fail until it is added (bin/mail.js templates set)`);
          }
        }
      } catch (e) {
        log(`Mail template seed skipped: ${e.message}`);
      }
    }

    // --- MFA: SMS enrolments left without an active method ---
    // Typically after the legacy services.mfa.mode is removed without
    // activating methods.sms: those accounts can no longer log in. Counted
    // where the engine has a cheap cross-user query (PostgreSQL); the SQLite
    // engine keeps one file per user, so it is not counted there (each refused
    // login still logs a warning). Never blocks the boot.
    {
      const mfaLogger = getLogger('mfa');
      const { describeInactiveSmsEnrolments } = require('../components/business/src/mfa/configCheck.ts');
      const profileStorage = require('../storages/index.ts').storageLayer?.profile;
      const count = (profileStorage != null && typeof profileStorage.countSmsMfaEnrolments === 'function')
        ? () => profileStorage.countSmsMfaEnrolments()
        : null;
      const message = await describeInactiveSmsEnrolments(config.get('services:mfa'), count,
        (err) => mfaLogger.debug(`SMS enrolment count skipped: ${err && err.message}`));
      if (message != null) warn(`[mfa] ${message}`);
    }

    // Keep master alive while workers run (tcp_pubsub sockets are unref'd)
    const keepAlive = setInterval(() => {}, 60000);

    // Periodic sweep of expired access-state rows. OAuth authorization
    // codes and refresh tokens live under the PlatformDB `access-state/`
    // keyspace with a TTL (/reg/access request states do not: they are
    // core-local in cluster_kv, which expires its own entries). Expiry is
    // otherwise LAZY (delete-on-read), so a code or token that is minted and
    // then never presented again would linger as a permanent cluster
    // keyValue row — unbounded growth over the life of the cluster. This
    // runs in the master only (once per cluster), is idempotent, and is
    // best-effort (a failed sweep just retries next interval).
    const sweepIntervalMs = config.get('accessState:sweepIntervalMs') || 15 * 60 * 1000;
    const accessStateSweep = setInterval(() => {
      const storagesBarrel = require('../storages/index.ts');
      const platformDB = storagesBarrel.platformDB;
      const { revokeExpiredCodeOrphans } = require('../components/oauth2/src/orphanSweep.ts');
      // Revoke the pre-minted access behind each EXPIRED, never-exchanged OAuth
      // authorization code BEFORE the generic sweep removes the code row (see
      // orphanSweep.ts: this core deletes its own orphans from storage; legacy
      // rows are revoked over HTTP). Best-effort and capped per tick.
      const revokeOrphans = revokeExpiredCodeOrphans({
        platform: platformDB,
        coreId: String(config.get('core:id') ?? 'single'),
        resolveUsername: async (userId) => (await storagesBarrel.usersLocalIndex.getUsername(userId)) ?? null,
        revokeLocal: async ({ userId, username, accessId, clientId }) => {
          const accesses = storagesBarrel.storageLayer.accesses;
          const user = { id: userId, username };
          // Only the client's OAuth session access: a row must not reach any other access.
          const access = await new Promise((resolve, reject) =>
            accesses.findOne(user, { id: accessId }, null, (err, a) => (err != null ? reject(err) : resolve(a))));
          if (access == null || access.type !== 'app' || access.name !== 'oauth:' + clientId) return;
          // Never delivered to a client, so no cached access logic to invalidate.
          await new Promise((resolve, reject) =>
            accesses.delete(user, { id: accessId }, (err) => (err != null ? reject(err) : resolve())));
        }
      })
        .then((revoked) => {
          if (revoked > 0) log(`[oauth-orphan-revoke] revoked ${revoked} orphaned pre-minted access(es)`);
        })
        .catch((err) => log(`[oauth-orphan-revoke] failed: ${err.message}`));

      // Sweep AFTER the orphan-revoke pass, so the expired code rows are still
      // present when listExpiredAccessStates reads their pre-minted access
      // details (the sweep would otherwise delete them out from under it).
      revokeOrphans.finally(() => {
        platformDB.sweepExpiredAccessStates()
          .then(({ removed }) => {
            if (removed > 0) log(`[access-state-sweep] removed ${removed} expired row(s)`);
          })
          .catch((err) => log(`[access-state-sweep] failed: ${err.message}`));
      });
      // Platform-wide counters (e.g. the SMS budget per destination) whose
      // window ended: they hold destination hashes, kept no longer than needed.
      platformDB.sweepExpiredWindowedCounters()
        .then(({ removed }) => {
          if (removed > 0) log(`[counter-sweep] removed ${removed} expired counter(s)`);
        })
        .catch((err) => log(`[counter-sweep] failed: ${err.message}`));
      // Prune operator-revoke tombstones + the advisory key inventory older than
      // the max token lifetime: past it every token the revoke could have killed
      // is already expired, so the marker's job is done. Keeps the per-core-cached
      // revoked sets from growing over the cluster's life.
      // NB: uses the CURRENT absolute cap. If an operator ever DECREASES
      // oauth.refreshTokenAbsoluteTTL, a tombstone could be pruned while a chain
      // issued under the old (larger) cap is still alive — the prune floor should
      // really be the max cap ever configured. Bounded-edge; documented not fixed.
      const maxTokenTtlMs = (Number(config.get('oauth:refreshTokenAbsoluteTTL')) || 90 * 24 * 3600) * 1000;
      const oauthStorage = require('../components/oauth2/src/storage.ts');
      // Client-revoke (per-clientId epoch) tombstones.
      oauthStorage.pruneRevokedClients(platformDB, maxTokenTtlMs)
        .then((pruned) => { if (pruned > 0) log(`[revoke-tombstone-prune] removed ${pruned} stale tombstone(s)`); })
        .catch((err) => log(`[revoke-tombstone-prune] failed: ${err.message}`));
      // Revoke-by-key (per-jkt presence) tombstones.
      oauthStorage.pruneRevokedDpopKeys(platformDB, maxTokenTtlMs)
        .then((pruned) => { if (pruned > 0) log(`[revoke-key-tombstone-prune] removed ${pruned} stale tombstone(s)`); })
        .catch((err) => log(`[revoke-key-tombstone-prune] failed: ${err.message}`));
      // Advisory DPoP key-inventory rows (pick-list; no live tokens past the cap).
      oauthStorage.pruneDpopKeysSeen(platformDB, maxTokenTtlMs)
        .then((pruned) => { if (pruned > 0) log(`[dpop-key-inventory-prune] removed ${pruned} stale row(s)`); })
        .catch((err) => log(`[dpop-key-inventory-prune] failed: ${err.message}`));
    }, sweepIntervalMs);
    accessStateSweep.unref(); // keepAlive holds the master; the sweep must not

    // Opt-in purge of access deletion records (with their version rows and
    // index rows) past `accesses.deletionRecords.retentionDays`; off at 0.
    // Master only, once a day. A bad value refuses the boot here: a retention
    // the operator set must not be silently dropped.
    const { startAccessDeletionRecordsPurge } = require('../components/business/src/accesses/deletionRecordsPurge.ts');
    startAccessDeletionRecordsPurge({
      config,
      accesses: require('../storages/index.ts').storageLayer.accesses,
      listUsers: async () => {
        const byName = await require('../storages/index.ts').usersLocalIndex.getAllByUsername();
        return Object.entries(byName).map(([username, id]) => ({ id, username }));
      },
      deleteIndexRow: (accessId) => require('../components/platform/src/accessIndex.ts')
        .deleteAccessIndexRow(require('../storages/index.ts').platformDB, accessId),
      logger: { warn },
      log
    });

    // Periodic platform DB integrity check, this core's copy: the same
    // read-only check as at boot. The copy can be damaged while the core runs
    // (e.g. a snapshot restore inside rqlite) and nothing else would say so.
    // ERROR at every failed check, INFO once when it passes again.
    const { startPlatformIntegrityMonitor, resolveIntervalMs } = require('../storages/interfaces/platformStorage/integrityMonitor.ts');
    const platformIntegrityMonitor = startPlatformIntegrityMonitor({
      check: () => require('../storages/index.ts').platformDB.checkStoreIntegrity(),
      intervalMs: resolveIntervalMs(config.get('storages:platform:integrityCheckIntervalMs')),
      initialOk: bootIntegrityOk,
      logger: {
        info: log,
        warn,
        error
      }
    });

    // Start TCP pub/sub broker in master (workers connect as clients)
    const tcpPubsub = require('../components/messages/src/tcp_pubsub.ts');
    await tcpPubsub.init();
    log('TCP pub/sub broker started');

    // Cluster-wide ephemeral kv — master-held Map + request/response
    // IPC with workers. Used for state that must be shared across
    // workers but doesn't need persistence (single-core scope;
    // cross-core state belongs in PlatformDB instead).
    require('../components/messages/src/cluster_kv.ts').masterStart({
      log: (m) => log('[cluster_kv] ' + m)
    });

    // dns-active first-boot DNS chain bootstrap.
    // Without this block, a fresh single-core dns-active deployment ships
    // an empty embedded DNS server: parent-zone NS delegation reaches us,
    // but the apex SOA/NS answer is empty and the recursor discards the
    // delegation. acme-client's DNS-01 preflight then errors with
    // "No TXT records found for name: _acme-challenge.<domain>" before
    // the LE round-trip even starts.
    //
    // We seed the bootstrap chain from `dns.publicIp` (collected by the
    // wizard or hand-set in the YAML):
    //   - SOA + NS for the apex go into the in-memory boiler config under
    //     `dns:records:root` (DnsServer's #answerRoot reads only from
    //     YAML config — PlatformDB-runtime entries are per-subdomain).
    //   - `A core.<domain>` lands in PlatformDB via setDnsRecord('core')
    //     so the canonical API hostname resolves to this host.
    // Idempotency: skip whichever of (root.soa, root.ns, the 'core' entry)
    // already carries content — operator-managed records, whether typed
    // into YAML or loaded via `bin/dns-records.js`, always win.
    let dnsBootstrapFatal = null;
    if (config.get('dns:active') && config.get('dns:domain')) {
      const dnsDomain = config.get('dns:domain');
      const publicIp = config.get('dns:publicIp');
      if (!publicIp) {
        dnsBootstrapFatal =
          `dns.publicIp is unset, but dns.active=true + dns.domain=${dnsDomain}. ` +
          'The embedded DNS server cannot answer the apex SOA/NS records the parent ' +
          'zone NS delegation points at. Set dns.publicIp to this host\'s public IPv4 ' +
          'address and restart.';
        log('FATAL: ' + dnsBootstrapFatal);
        log('       ACME orchestrator will NOT start (would burn the LE rate limit on a guaranteed-fail issuance).');
      } else {
        const leEmail = config.get('letsEncrypt:email');
        const adminEmail = (typeof leEmail === 'string' && leEmail.includes('@')) ? leEmail : ('admin@' + dnsDomain);
        const rfc1035Admin = adminEmail.replace('@', '.') + '.';
        const primaryNs = `core.${dnsDomain}.`;
        const existingRoot = (config.get('dns:records:root') || {});
        const nextRoot = { ...existingRoot };
        let mutated = false;
        if (!existingRoot.soa) {
          nextRoot.soa = {
            primary: primaryNs,
            admin: rfc1035Admin,
            serial: Math.floor(Date.now() / 1000),
            refresh: 3600,
            retry: 600,
            expiration: 604800,
            minimum: 60
          };
          mutated = true;
          log(`[dns-bootstrap] seeded dns.records.root.soa (primary=${primaryNs}, admin=${rfc1035Admin})`);
        }
        if (!existingRoot.ns || existingRoot.ns.length === 0) {
          nextRoot.ns = [primaryNs];
          mutated = true;
          log(`[dns-bootstrap] seeded dns.records.root.ns = [${primaryNs}]`);
        }
        if (mutated) config.set('dns:records:root', nextRoot);

        const { getPlatform } = require('../components/platform/src/index.ts');
        const bootstrapPlatform = await getPlatform();
        const existingCore = await bootstrapPlatform.getDnsRecord('core');
        if (existingCore == null) {
          if (!require('node:net').isIPv4(String(publicIp))) {
            // A configuration error, not a crash: stop with a FATAL line and no stack.
            const fatal = new Error(
              `dns.publicIp (${JSON.stringify(publicIp)}) cannot be published as A core.${dnsDomain}: not an IPv4 address. ` +
              'Set dns.publicIp to this host\'s public IPv4 address and restart.');
            fatal.bootFatal = true;
            throw fatal;
          }
          await bootstrapPlatform.setDnsRecord('core', { a: [publicIp] });
          log(`[dns-bootstrap] published A core.${dnsDomain} -> ${publicIp}`);
        } else {
          log(`[dns-bootstrap] A core.${dnsDomain} already set in PlatformDB; not overwriting`);
        }
      }
    }

    // Start DNS server if configured
    let dnsServer = null;
    if (config.get('dns:active')) {
      const { createDnsServer } = require('../components/dns-server/src/index.ts');
      const { getPlatform } = require('../components/platform/src/index.ts');
      const platform = await getPlatform();
      dnsServer = createDnsServer({
        config,
        platform,
        logger: getLogger('dns-server')
      });
      await dnsServer.start({
        port: config.get('dns:port') || 5353,
        ip: config.get('dns:ip') || '0.0.0.0',
        ip6: config.get('dns:ip6') || null
      });
      log('DNS server started');
    }

    // --- Let's Encrypt orchestrator ---
    // On every core: poll PlatformDB every minute, write rotated cert to
    // tlsDir/<host>/ on disk, invoke letsEncrypt.onRotateScript if set.
    // On the CA-holder (letsEncrypt.certRenewer: true) additionally runs
    // the daily ACME renewal loop (initial issuance + renew-when-expiring).
    let acmeOrchestrator = null;
    if (config.get('letsEncrypt:enabled') && dnsBootstrapFatal) {
      log('[acme] skipping orchestrator start — dns-active bootstrap FATAL above means DNS-01 cannot succeed.');
    } else if (config.get('letsEncrypt:enabled')) {
      // First-boot race: workers do `fs.readFileSync(http.ssl.keyFile)` at
      // boot. If ACME hasn't issued yet, that ENOENTs and the cluster
      // restart-loops. Pre-stage a 1-day self-signed cert at the configured
      // paths so workers can boot HTTPS; the real cert hot-swaps via
      // setSecureContext when ACME completes.
      try {
        const { ensure: ensurePlaceholder } = require('business/src/acme/selfSignedPlaceholder.ts');
        const placeholder = ensurePlaceholder({ config, log });
        if (placeholder.written) {
          log(`[acme] placeholder cert in place at ${placeholder.certFile}`);
        } else if (placeholder.restored) {
          log(`[acme] real LE cert restored at ${placeholder.certFile} from ${placeholder.source}`);
        }
      } catch (err) {
        log('[acme] placeholder cert generation FAILED: ' + err.message + ' (workers may crash on first boot until ACME completes)');
        if (process.env.DEBUG) console.error(err.stack);
      }
      try {
        const { getPlatform } = require('../components/platform/src/index.ts');
        const platform = await getPlatform();
        const { buildAcmeOrchestrator } = require('business/src/acme/index.ts');
        const atRestKeyB64 = config.get('letsEncrypt:atRestKey');
        if (!atRestKeyB64 || atRestKeyB64 === 'REPLACE ME') {
          throw new Error('letsEncrypt.atRestKey is required when letsEncrypt.enabled=true (generate with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`)');
        }
        const atRestKey = Buffer.from(atRestKeyB64, 'base64');
        if (atRestKey.length !== 32) {
          throw new Error(`letsEncrypt.atRestKey must decode to 32 bytes; got ${atRestKey.length}`);
        }

        // HTTP-01 challenge support: when the topology resolves to http-01
        // (typically `dnsLess.isActive: true`), bind a tiny HTTP server on
        // :80 that serves /.well-known/acme-challenge/<token> from an
        // in-memory store. CertRenewer.challengeCreateFn writes into the
        // same store. DNS-01 mode skips this entirely; only the DNS
        // writer path is exercised.
        const { Http01ChallengeStore } = require('business/src/acme/Http01ChallengeStore.ts');
        const { createHttp01Server } = require('business/src/acme/Http01Server.ts');
        const http01Store = new Http01ChallengeStore();
        try {
          const http01Server = createHttp01Server({
            store: http01Store,
            port: 80,
            host: '0.0.0.0',
            log: (m) => log('[acme] ' + m)
          });
          await http01Server.listenAsync();
          log('[acme] http-01 challenge server listening on :80');
        } catch (err) {
          log('[acme] http-01 server failed to bind :80: ' + err.message);
          log('[acme]   (DNS-01 deployments can ignore this; http-01 challenges will fail)');
        }

        acmeOrchestrator = buildAcmeOrchestrator({
          config,
          platformDB: platform._db || require('../storages/index.ts').platformDB,
          atRestKey,
          dnsServer,
          http01Store,
          onRotate: async (certPath, keyPath, hostname) => {
            // Workers' reloadTls() re-reads from `http.ssl.{certFile,keyFile}`
            // (Server.buildHttpsOptions) — it does NOT use the certPath/keyPath
            // carried on the IPC message. So we land the rotated cert at the
            // configured ssl paths BEFORE the IPC fanout. The materializer
            // writes the per-host layout (`<tlsDir>/<host>/{fullchain,privkey}.pem`);
            // we mirror it to the single-path layout the workers actually read.
            // Without this, in-memory hot-swap silently re-loads the
            // placeholder and the workers serve self-signed permanently.
            try {
              const sslKeyFile = config.get('http:ssl:keyFile');
              const sslCertFile = config.get('http:ssl:certFile');
              if (sslKeyFile && sslCertFile) {
                const fs = require('node:fs');
                const path = require('node:path');
                fs.mkdirSync(path.dirname(sslKeyFile), { recursive: true });
                fs.mkdirSync(path.dirname(sslCertFile), { recursive: true });
                fs.copyFileSync(certPath, sslCertFile);
                fs.copyFileSync(keyPath, sslKeyFile);
                fs.chmodSync(sslCertFile, 0o644);
                fs.chmodSync(sslKeyFile, 0o600);
                log(`[acme] copied rotated cert ${certPath} -> ${sslCertFile}`);
              }
            } catch (err) {
              log(`[acme] failed to mirror rotated cert to ssl paths: ${err.message} (workers will still serve the OLD cert until next rotation)`);
            }
            // Broadcast to every live worker so their HTTPS servers
            // hot-swap to the rotated cert. Workers that aren't serving
            // HTTPS (hfs, previews, and api-server in http-only mode)
            // ignore the message.
            const msg = { type: 'acme:rotate', hostname, certPath, keyPath };
            for (const id in cluster.workers) {
              try { cluster.workers[id].send(msg); } catch (err) {
                log(`[acme] IPC to worker ${id} failed: ${err.message}`);
              }
            }
          },
          log: (m) => log(m.startsWith('[acme]') ? m : '[acme] ' + m)
        });
        acmeOrchestrator.start();
        log('Let\'s Encrypt orchestrator started');
      } catch (err) {
        log('Let\'s Encrypt orchestrator FAILED to start: ' + err.message);
        if (process.env.DEBUG) console.error(err.stack);
        // Intentionally do NOT exit the master — operators can run with a
        // misconfigured letsEncrypt block and fix it without restart.
      }
    }

    // Track worker types for targeted restart
    const workerTypes = new Map(); // worker.id → 'api' | 'hfs' | 'previews'
    let apiWorkerId = 0;
    let hfsWorkerId = 0;
    // Replacements of workers that keep dying soon after they started are
    // delayed, doubling up to a cap (see workerRestartBackoff.ts).
    const { createWorkerRestartBackoff } = require('business/src/workerRestartBackoff.ts');
    const restartBackoff = createWorkerRestartBackoff();
    const workerStartedAt = new Map(); // worker.id → fork time (ms)
    cluster.on('fork', (worker) => workerStartedAt.set(worker.id, Date.now()));

    // Observability env vars workers inherit via setupPrimary.
    // Effective config comes from `Platform.getObservabilityConfig()` which
    // merges PlatformDB rows + local YAML + derives hostname. Resolving it
    // once here keeps every worker on the same posture without each one
    // querying PlatformDB at boot. `buildObservabilityEnv` returns an empty
    // object when disabled or without an endpoint — workers then stay silent.
    let observabilityEnv = {};
    try {
      const { getPlatform } = require('../components/platform/src/index.ts');
      const platform = await getPlatform();
      const obs = await platform.getObservabilityConfig();
      const { buildObservabilityEnv } = require('business/src/observability/envBuilder.ts');
      observabilityEnv = buildObservabilityEnv(obs);
      if (Object.keys(observabilityEnv).length > 0) {
        log(`[observability] telemetry enabled host=${obs.hostname} endpoint=${obs.otlp.endpoint}`);
      } else if (obs.enabled) {
        log('[observability] enabled but no endpoint configured — not activating');
      }
    } catch (err) {
      log('[observability] getObservabilityConfig FAILED: ' + err.message + ' — workers start without telemetry');
      if (process.env.DEBUG) console.error(err.stack);
    }

    // --- API workers ---
    const configuredApiWorkers = config.get('cluster:apiWorkers');
    const numApiWorkers = (configuredApiWorkers != null)
      ? configuredApiWorkers
      : Math.min(os.cpus().length, 4);

    // Propagate CLI argv (e.g. `--config host-config.yml`) to every worker.
    // Without this, cluster.fork() runs master.js again with just argv[0,1],
    // workers fall back to NODE_ENV-based config, and deployments relying
    // on --config silently use the wrong storage engine / ports.
    // (euc1 api workers were crash-looping on Mongo).
    cluster.setupPrimary({ args: process.argv.slice(2) });

    let webhooksWorkerId = null; // cluster id of the API worker running the webhooks service
    let cmcLoopWorkerId = null; // cluster id of the API worker running the CMC retry loop
    log(`Forking ${numApiWorkers} API worker(s)`);
    for (let i = 0; i < numApiWorkers; i++) {
      forkApiWorker();
    }

    function forkApiWorker () {
      const id = apiWorkerId++;
      // One API worker runs the webhooks service: every worker receives every
      // change notification and every webhook, so a service in each worker
      // would call each webhook once per worker. Its replacement takes over.
      const runsWebhooks = webhooksWorkerId == null;
      // One API worker runs the CMC retry loop and ledger pass, for the same
      // reason; its replacement takes over too, so a worker crash never
      // stops the loop until the master restarts.
      const runsCmcLoop = cmcLoopWorkerId == null;
      const worker = cluster.fork({
        PRYV_WORKER_TYPE: 'api',
        PRYV_BOILER_SUFFIX: `-w${id}`,
        PRYV_WEBHOOKS_WORKER: runsWebhooks ? '1' : '0',
        PRYV_CMC_LOOP_WORKER: runsCmcLoop ? '1' : '0',
        ...observabilityEnv
      });
      workerTypes.set(worker.id, 'api');
      if (runsWebhooks) webhooksWorkerId = worker.id;
      if (runsCmcLoop) cmcLoopWorkerId = worker.id;
      log(`API worker w${id} started (pid ${worker.process.pid})${runsWebhooks ? ', runs the webhooks service' : ''}${runsCmcLoop ? ', runs the CMC retry loop' : ''}`);
    }

    // --- HFS workers ---
    const numHfsWorkers = config.get('cluster:hfsWorkers') ?? 1;

    if (numHfsWorkers > 0) {
      log(`Forking ${numHfsWorkers} HFS worker(s)`);
      for (let i = 0; i < numHfsWorkers; i++) {
        forkHfsWorker();
      }
    } else {
      log('HFS workers disabled (cluster:hfsWorkers = 0)');
    }

    function forkHfsWorker () {
      const id = hfsWorkerId++;
      const worker = cluster.fork({
        PRYV_WORKER_TYPE: 'hfs',
        PRYV_BOILER_SUFFIX: `-hfs${id}`,
        ...observabilityEnv
      });
      workerTypes.set(worker.id, 'hfs');
      log(`HFS worker hfs${id} started (pid ${worker.process.pid})`);
    }

    // --- Previews worker ---
    let previewsWorkerId = 0;
    const previewsEnabled = config.get('cluster:previewsWorker') ?? true;

    if (previewsEnabled) {
      forkPreviewsWorker();
    } else {
      log('Previews worker disabled (cluster:previewsWorker = false)');
    }

    function forkPreviewsWorker () {
      const id = previewsWorkerId++;
      const worker = cluster.fork({
        PRYV_WORKER_TYPE: 'previews',
        PRYV_BOILER_SUFFIX: `-prev${id}`,
        ...observabilityEnv
      });
      workerTypes.set(worker.id, 'previews');
      log(`Previews worker prev${id} started (pid ${worker.process.pid})`);
    }

    // --- IPC from workers (DNS record updates) ---
    // The worker already persisted the record to PlatformDB before
    // sending this IPC. Master refreshes from PlatformDB to pick it
    // up atomically (instead of trusting the IPC payload) — any other
    // core in the deployment will do the same via its next periodic
    // refresh.
    if (dnsServer) {
      cluster.on('message', (worker, msg) => {
        if (msg && msg.type === 'dns:updateRecords') {
          dnsServer.refreshFromPlatform().catch((err) => {
            log('DNS refresh after IPC failed: ' + err.message);
          });
        }
      });
    }

    // Relay mail-template invalidations to every sibling worker so their
    // in-process `mail` templates re-materialise from PlatformDB at once.
    // Emitted by the admin-API PUT/DELETE handlers after a successful write,
    // once the serving worker has reloaded its own
    // (see components/api-server/src/routes/system.ts).
    cluster.on('message', (worker, msg) => {
      if (msg && msg.type === 'mail:template-invalidate') {
        for (const id in cluster.workers) {
          if (cluster.workers[id] === worker) continue; // the sender refreshed itself before sending
          try { cluster.workers[id].send(msg); } catch (err) {
            log(`[mail] IPC to worker ${id} failed: ${err.message}`);
          }
        }
      }
    });

    // Admin force-renew IPC. The api-server route
    // POST /system/admin/certs/force-renew runs in a worker; it sends
    // `acme:force-renew` to the master, which holds the
    // AcmeOrchestrator, and waits for `acme:force-renew:reply`. Non-
    // renewer cores reply with ok:false so the route can return a 400.
    cluster.on('message', async (worker, msg) => {
      if (!msg || msg.type !== 'acme:force-renew') return;
      const reply = { type: 'acme:force-renew:reply', requestId: msg.requestId };
      try {
        if (acmeOrchestrator == null) {
          worker.send({ ...reply, ok: false, error: 'letsEncrypt orchestrator not running on this core' });
          return;
        }
        if (!acmeOrchestrator.isRenewer) {
          worker.send({ ...reply, ok: false, error: 'not the certRenewer core' });
          return;
        }
        const result = await acmeOrchestrator.forceRenew(msg.hostname || undefined);
        worker.send({
          ...reply,
          ok: true,
          hostname: result.hostname,
          issuedAt: result.issuedAt,
          expiresAt: result.expiresAt
        });
      } catch (err) {
        log('[acme] force-renew failed: ' + err.message);
        try { worker.send({ ...reply, ok: false, error: err.message }); } catch (_) {}
      }
    });

    // --- Shutdown ---
    // The master exits only after rqlited has exited: rqlited snapshots the
    // platform DB when it closes, and leaving first can interrupt that
    // snapshot (see components/business/src/masterShutdown.ts).
    const { createMasterShutdown } = require('business/src/masterShutdown.ts');
    const masterShutdown = createMasterShutdown({
      cluster,
      stopServices: async () => {
        clearInterval(keepAlive);
        clearInterval(accessStateSweep);
        platformIntegrityMonitor.stop();
        // Stop ACME orchestrator (clears intervals)
        if (acmeOrchestrator) acmeOrchestrator.stop();
        if (dnsServer) await dnsServer.stop();
        require('../components/platform/src/index.ts').platform.stopCoreUrlRefresh();
      },
      stopRqlite: () => rqliteProcess.isRunning()
        ? rqliteProcess.stop(log, error)
        : Promise.resolve(),
      log,
      warn,
      exit: (code) => process.exit(code)
    });

    // --- Worker lifecycle ---
    cluster.on('exit', (worker, code, signal) => {
      const type = workerTypes.get(worker.id);
      workerTypes.delete(worker.id);
      if (masterShutdown.isShuttingDown()) {
        masterShutdown.onWorkerExit();
        return;
      }
      const startedAt = workerStartedAt.get(worker.id);
      workerStartedAt.delete(worker.id);
      const uptimeMs = startedAt == null ? 0 : Date.now() - startedAt;
      const delayMs = restartBackoff.onWorkerExit(type ?? 'api', uptimeMs);
      // Released at once, not after the delay: the next API worker forked
      // (this one's replacement or another's) takes over the webhooks service.
      if (worker.id === webhooksWorkerId) webhooksWorkerId = null;
      if (worker.id === cmcLoopWorkerId) cmcLoopWorkerId = null;
      log(`${type ?? 'unknown'} worker pid ${worker.process.pid} died (code=${code} signal=${signal}) after ${Math.round(uptimeMs / 1000)}s, ` +
        (delayMs > 0 ? `restarting in ${Math.round(delayMs / 1000)}s (it keeps dying soon after start)` : 'restarting'));
      setTimeout(() => {
        if (masterShutdown.isShuttingDown()) return;
        if (type === 'hfs') {
          forkHfsWorker();
        } else if (type === 'previews') {
          forkPreviewsWorker();
        } else {
          forkApiWorker();
        }
      }, delayMs);
    });

    // A worker leaves `cluster.workers` once it has both exited and
    // disconnected, in either order.
    cluster.on('disconnect', () => masterShutdown.onWorkerExit());

    process.on('SIGTERM', () => masterShutdown.shutdown('SIGTERM'));
    process.on('SIGINT', () => masterShutdown.shutdown('SIGINT'));

    log('Master process ready');
  })().catch(async err => {
    if (err && err.bootFatal) {
      // The logger once boiler is initialised; the raw console before that.
      try {
        require('@pryv/boiler').getLogger('master').error('FATAL: ' + err.message);
      } catch {
        console.error('[master] FATAL: ' + err.message);
      }
    } else {
      console.error('Master startup failed:', err);
    }
    // Let an rqlited started by this boot finish its snapshot-on-close first.
    try {
      const rqliteProcess = require('../storages/engines/rqlite/src/rqliteProcess.ts');
      if (rqliteProcess.isRunning()) await rqliteProcess.stop((msg) => console.log(`[master] ${msg}`));
    } catch { /* exit anyway */ }
    process.exit(1);
  });
} else {
  // Worker: route to the correct server based on type
  if (process.env.PRYV_WORKER_TYPE === 'hfs') {
    require('../components/hfs-server/bin/server');
  } else if (process.env.PRYV_WORKER_TYPE === 'previews') {
    require('../components/previews-server/bin/server');
  } else {
    require('../components/api-server/bin/server');
  }
}

// ---------------------------------------------------------------------------
// Bootstrap-mode helpers (only invoked from the primary block above)
// ---------------------------------------------------------------------------

function parseBootstrapArgs (argv) {
  const out = { enabled: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bootstrap') { out.enabled = true; out.bundlePath = argv[++i]; } else if (a === '--bootstrap-passphrase-file') { out.passphraseFile = argv[++i]; } else if (a === '--bootstrap-tls-dir') { out.tlsDir = argv[++i]; } else if (a === '--bootstrap-config-dir') { out.configDir = argv[++i]; } else if (a === '--bootstrap-ack-trust-system-ca') { out.trustSystemCa = true; } else if (a === '--bootstrap-as-voter') { out.asVoter = true; } else if (a === '--bootstrap-as-non-voter') { out.asNonVoter = true; } else if (a === '--bootstrap-clock-skew-seconds') { out.clockSkewSeconds = argv[++i]; } else if (a === '--bootstrap-force') { out.force = true; }
  }
  if (out.enabled) {
    if (!out.bundlePath) throw new Error('--bootstrap requires <bundle-file>');
    if (!out.passphraseFile) throw new Error('--bootstrap requires --bootstrap-passphrase-file');
    out.tlsDir = out.tlsDir || DEFAULT_TLS_DIR;
    out.configDir = out.configDir || BASE_CONFIG_DIR;
    if (out.clockSkewSeconds != null) {
      const seconds = Number(out.clockSkewSeconds);
      if (out.clockSkewSeconds === '' || !Number.isFinite(seconds) || seconds < 0) {
        throw new Error('--bootstrap-clock-skew-seconds requires a number of seconds >= 0');
      }
      out.clockSkewSeconds = seconds;
    }
  }
  return out;
}

async function runBootstrap (args) {
  const { consumer } = require('business/src/bootstrap/index.ts');
  console.log('[bootstrap] starting --bootstrap from ' + args.bundlePath);
  const result = await consumer.consume({
    bundlePath: args.bundlePath,
    passphraseFile: args.passphraseFile,
    configDir: args.configDir,
    tlsDir: args.tlsDir,
    trustSystemCa: args.trustSystemCa === true,
    // Default to non-voter join (safe by default). --bootstrap-as-voter opts
    // into a voting node for >=3-core HA clusters.
    asNonVoter: args.asVoter !== true,
    // Join although override-config.yml sets keys the bundle provides (they keep winning).
    force: args.force === true,
    // Undefined keeps the consumer's default (30 s); 0 disables the check.
    clockSkewSeconds: args.clockSkewSeconds,
    log: (m) => console.log('[bootstrap] ' + m)
  });
  console.log('[bootstrap] joined cluster as ' + result.coreId);
  console.log('[bootstrap] bootstrap-config: ' + result.configPath);
  if (result.previousGeneratedOverrideBackup != null) {
    console.log('[bootstrap] the override-config.yml written by an earlier --bootstrap was moved to ' + result.previousGeneratedOverrideBackup +
      ': copy back into override-config.yml any setting you had added there');
  }
  console.log('[bootstrap] continuing into normal startup ...');
}
