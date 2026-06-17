#!/usr/bin/env node

// Observability boot MUST come before any other require so APM agents
// can instrument http/express/pg from the start. No-op in NODE_ENV=test
// or when PRYV_OBSERVABILITY_PROVIDER is unset.
require('./_observability-boot');

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
//                      [--bootstrap-ack-trust-system-ca]
//
// --bootstrap-ack-trust-system-ca: verify the ack POST against the system CA
//   store instead of pinning the cluster CA. Needed when the existing core's
//   API origin is fronted by a public/ACME cert (the normal internet-facing
//   case). The one-shot join token remains the authenticator.
//
// In --bootstrap mode the master decrypts the bundle, writes
// `override-config.yml` + TLS files, posts an ack to the issuing core, then
// falls through into normal startup — picking up the freshly-written config
// via @pryv/boiler's highest-precedence override-file slot.
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
    // override-config.yml it writes is picked up at the highest precedence
    // by the init below. Workers (cluster.fork()) skip this block entirely.
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
    // override-config.yml the bootstrap step wrote above).
    require('@pryv/boiler').init({
      appName: 'master',
      baseFilesDir: path.resolve(__dirname, '../'),
      baseConfigDir: BASE_CONFIG_DIR,
      extraConfigs: [{
        pluginAsync: require('../config/plugins/systemStreams')
      }, {
        plugin: require('../config/plugins/core-identity')
      }, {
        // Fail master startup if required service fields are missing so
        // operators see the problem immediately rather than through
        // api-server worker crash loops.
        plugin: require('../config/plugins/config-validation')
      }]
    });

    const { getConfig, getLogger } = require('@pryv/boiler');
    const rqliteProcess = require('../storages/engines/rqlite/src/rqliteProcess.ts');

    const config = await getConfig();
    const logger = getLogger('master');
    const log = (msg) => { logger.info(msg); console.log(`[master] ${msg}`); };
    const warn = (msg) => { logger.warn(msg); console.warn(`[master] WARNING: ${msg}`); };

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
        await rqliteProcess.waitForExternal(rqliteConfig.url || 'http://localhost:4001', 30000, log);
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
          coreIp: config.get('core:ip') || null,
          tls: rqliteConfig.tls || null,
          log
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

    // --- Mail template seed ---
    // First-boot bootstrap: when `services.email.method === 'in-process'` and
    // `templatesRootDir` points at a Pug directory, populate PlatformDB from
    // disk if empty. Idempotent — subsequent boots are a no-op (the admin
    // CLI / admin API that ship later own the edit path).
    if (config.get('services:email:method') === 'in-process') {
      try {
        const platformDB = require('../storages/index.ts').platformDB;
        const { seedIfEmpty } = require('../components/mail/src/TemplateSeeder.ts');
        const result = await seedIfEmpty({
          platformDB,
          templatesRootDir: config.get('services:email:templatesRootDir') || null
        });
        if (result.seeded) log(`Mail templates seeded (${result.count} row(s))`);
      } catch (e) {
        log(`Mail template seed skipped: ${e.message}`);
      }
    }

    // Keep master alive while workers run (tcp_pubsub sockets are unref'd)
    const keepAlive = setInterval(() => {}, 60000);

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
        const adminEmail = config.get('letsEncrypt:email') || ('admin@' + dnsDomain);
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
    let shuttingDown = false;
    let apiWorkerId = 0;
    let hfsWorkerId = 0;

    // Observability env vars workers inherit via setupPrimary.
    // Effective config comes from `Platform.getObservabilityConfig()` which
    // merges PlatformDB rows + local YAML + derives hostname.
    // `buildObservabilityEnv` returns an empty object when disabled or
    // misconfigured — workers then see no provider env and the boot shim
    // no-ops.
    let observabilityEnv = {};
    try {
      const { getPlatform } = require('../components/platform/src/index.ts');
      const platform = await getPlatform();
      const obs = await platform.getObservabilityConfig();
      const { buildObservabilityEnv } = require('business/src/observability/envBuilder.ts');
      observabilityEnv = buildObservabilityEnv(obs);
      if (Object.keys(observabilityEnv).length > 0) {
        log(`[observability] provider=newrelic host=${obs.hostname} logLevel=${obs.logLevel}`);
      } else if (obs.enabled) {
        log(`[observability] enabled but provider=${obs.provider || 'unset'} or license-key unset — not activating`);
      }
    } catch (err) {
      log('[observability] getObservabilityConfig FAILED: ' + err.message + ' — workers start without APM');
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

    log(`Forking ${numApiWorkers} API worker(s)`);
    for (let i = 0; i < numApiWorkers; i++) {
      forkApiWorker();
    }

    function forkApiWorker () {
      const id = apiWorkerId++;
      const worker = cluster.fork({
        PRYV_WORKER_TYPE: 'api',
        PRYV_BOILER_SUFFIX: `-w${id}`,
        ...observabilityEnv
      });
      workerTypes.set(worker.id, 'api');
      log(`API worker w${id} started (pid ${worker.process.pid})`);
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

    // Broadcast mail-template invalidations to every sibling worker so all
    // in-process `mail` caches re-materialise from PlatformDB on the next
    // request. Emitted by the admin-API PUT/DELETE handlers after a
    // successful write (see components/api-server/src/routes/system.js).
    cluster.on('message', (worker, msg) => {
      if (msg && msg.type === 'mail:template-invalidate') {
        for (const id in cluster.workers) {
          if (cluster.workers[id] === worker) continue; // already wrote; no self-nudge
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

    // --- Worker lifecycle ---
    cluster.on('exit', (worker, code, signal) => {
      const type = workerTypes.get(worker.id);
      workerTypes.delete(worker.id);
      if (shuttingDown) return;
      log(`${type ?? 'unknown'} worker pid ${worker.process.pid} died (code=${code} signal=${signal}), restarting`);
      if (type === 'hfs') {
        forkHfsWorker();
      } else if (type === 'previews') {
        forkPreviewsWorker();
      } else {
        forkApiWorker();
      }
    });

    const shutdown = async (sig) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`Received ${sig}, shutting down workers...`);
      clearInterval(keepAlive);
      for (const id in cluster.workers) {
        cluster.workers[id].process.kill('SIGTERM');
      }
      // Stop ACME orchestrator (clears intervals)
      if (acmeOrchestrator) {
        acmeOrchestrator.stop();
      }
      // Stop DNS server
      if (dnsServer) {
        await dnsServer.stop();
      }
      // Stop rqlited after workers (so they can flush)
      if (rqliteProcess.isRunning()) {
        await rqliteProcess.stop(log);
      }
      // Force exit after timeout
      setTimeout(() => {
        log('Shutdown timeout, forcing exit');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Exit master when all workers have exited
    cluster.on('exit', () => {
      if (!shuttingDown) return;
      const remaining = Object.keys(cluster.workers).length;
      if (remaining === 0) {
        log('All workers stopped, master exiting');
        process.exit(0);
      }
    });

    log('Master process ready');
  })().catch(err => {
    console.error('Master startup failed:', err);
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
    if (a === '--bootstrap') { out.enabled = true; out.bundlePath = argv[++i]; } else if (a === '--bootstrap-passphrase-file') { out.passphraseFile = argv[++i]; } else if (a === '--bootstrap-tls-dir') { out.tlsDir = argv[++i]; } else if (a === '--bootstrap-config-dir') { out.configDir = argv[++i]; } else if (a === '--bootstrap-ack-trust-system-ca') { out.trustSystemCa = true; }
  }
  if (out.enabled) {
    if (!out.bundlePath) throw new Error('--bootstrap requires <bundle-file>');
    if (!out.passphraseFile) throw new Error('--bootstrap requires --bootstrap-passphrase-file');
    out.tlsDir = out.tlsDir || DEFAULT_TLS_DIR;
    out.configDir = out.configDir || BASE_CONFIG_DIR;
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
    log: (m) => console.log('[bootstrap] ' + m)
  });
  console.log('[bootstrap] joined cluster as ' + result.coreId);
  console.log('[bootstrap] override-config: ' + result.overridePath);
  console.log('[bootstrap] continuing into normal startup ...');
}
