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
    const rqliteProcess = require('../storages/engines/rqlite/src/rqliteProcess');

    const config = await getConfig();
    const logger = getLogger('master');
    const log = (msg) => { logger.info(msg); console.log(`[master] ${msg}`); };

    // Start rqlited — rqlite is the only supported platform engine, master.js owns the lifecycle.
    // When `storages.engines.rqlite.external` is true, skip spawning and connect to an
    // already-running instance (useful for multi-core deployments sharing one rqlited).
    const rqliteConfig = config.get('storages:engines:rqlite') || {};
    const httpPort = new URL(rqliteConfig.url || 'http://localhost:4001').port || 4001;
    if (rqliteConfig.external) {
      log(`Connecting to external rqlited at ${rqliteConfig.url || 'http://localhost:4001'}`);
      await rqliteProcess.waitForExternal(rqliteConfig.url || 'http://localhost:4001', 30000, log);
    } else {
      await rqliteProcess.start({
        coreId: config.get('core:id') || 'single',
        binPath: rqliteConfig.binPath || 'var-pryv/rqlite-bin/rqlited',
        dataDir: rqliteConfig.dataDir || 'var-pryv/rqlite-data',
        httpPort: parseInt(httpPort),
        raftPort: rqliteConfig.raftPort || 4002,
        dnsDomain: config.get('dns:domain') || null,
        coreIp: config.get('core:ip') || null,
        tls: rqliteConfig.tls || null,
        log
      });
    }

    // Run pending schema migrations before starting services.
    // Each migration-capable engine (see storages/interfaces/migrations/) gets
    // its pending up() calls applied in filename order; version bumps persist
    // in that engine's schema_migrations tracking row/table.
    const autoRunMigrations = config.get('migrations:autoRunOnStart') ?? true;
    if (autoRunMigrations) {
      log('Running pending schema migrations...');
      await require('../storages').init(config);
      const { createMigrationRunner } = require('../storages/interfaces/migrations');
      const runner = await createMigrationRunner({ logger: getLogger('migrations') });
      const applied = await runner.runAll();
      if (applied.length === 0) {
        log('No pending migrations.');
      } else {
        for (const m of applied) {
          log(`  ${m.engineId}: ${m.filename} (→ v${m.toVersion}, ${m.durationMs}ms)`);
        }
        log(`Applied ${applied.length} migration(s).`);
      }
    }

    // Keep master alive while workers run (tcp_pubsub sockets are unref'd)
    const keepAlive = setInterval(() => {}, 60000);

    // Start TCP pub/sub broker in master (workers connect as clients)
    const tcpPubsub = require('../components/messages/src/tcp_pubsub');
    await tcpPubsub.init();
    log('TCP pub/sub broker started');

    // Start DNS server if configured
    let dnsServer = null;
    if (config.get('dns:active')) {
      const { createDnsServer } = require('../components/dns-server/src');
      const { getPlatform } = require('../components/platform/src');
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
    if (config.get('letsEncrypt:enabled')) {
      try {
        const { getPlatform } = require('../components/platform/src');
        const platform = await getPlatform();
        const { buildAcmeOrchestrator } = require('business/src/acme');
        const atRestKeyB64 = config.get('letsEncrypt:atRestKey');
        if (!atRestKeyB64 || atRestKeyB64 === 'REPLACE ME') {
          throw new Error('letsEncrypt.atRestKey is required when letsEncrypt.enabled=true (generate with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`)');
        }
        const atRestKey = Buffer.from(atRestKeyB64, 'base64');
        if (atRestKey.length !== 32) {
          throw new Error(`letsEncrypt.atRestKey must decode to 32 bytes; got ${atRestKey.length}`);
        }
        acmeOrchestrator = buildAcmeOrchestrator({
          config,
          platformDB: platform._db || require('../storages').platformDB,
          atRestKey,
          dnsServer,
          onRotate: async (certPath, keyPath, hostname) => {
            // Broadcast to every live worker so their HTTPS servers hot-swap
            // to the rotated cert (Plan 35 Phase 4d). Workers that aren't
            // serving HTTPS (hfs, previews, and api-server in http-only mode)
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
    // merges PlatformDB rows + local YAML + derives hostname. Empty object
    // when disabled or misconfigured — workers then see no provider env and
    // the boot shim no-ops.
    let observabilityEnv = {};
    try {
      const { getPlatform } = require('../components/platform/src');
      const platform = await getPlatform();
      const obs = await platform.getObservabilityConfig();
      if (obs.enabled && obs.provider === 'newrelic' && obs.newrelic.licenseKey) {
        observabilityEnv = {
          PRYV_OBSERVABILITY_PROVIDER: 'newrelic',
          NEW_RELIC_LICENSE_KEY: obs.newrelic.licenseKey,
          NEW_RELIC_APP_NAME: obs.appName,
          NEW_RELIC_PROCESS_HOST_DISPLAY_NAME: obs.hostname,
          NEW_RELIC_LOG_LEVEL: obs.logLevel,
          NEW_RELIC_HIGH_SECURITY: 'true',
          // Let the agent find our config template (high_security + attr filters).
          NEW_RELIC_HOME: require('path').join(__dirname, '../components/business/src/observability/providers/newrelic')
        };
        log(`[observability] provider=newrelic host=${obs.hostname} logLevel=${obs.logLevel}`);
      } else if (obs.enabled) {
        log(`[observability] enabled but provider=${obs.provider || 'unset'} — not activating`);
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
    // Plan 27 Phase 1: the worker already persisted the record to PlatformDB
    // before sending this IPC. Master refreshes from PlatformDB to pick it up
    // atomically (instead of trusting the IPC payload) — any other core in the
    // deployment will do the same via its next periodic refresh.
    if (dnsServer) {
      cluster.on('message', (worker, msg) => {
        if (msg && msg.type === 'dns:updateRecords') {
          dnsServer.refreshFromPlatform().catch((err) => {
            log('DNS refresh after IPC failed: ' + err.message);
          });
        }
      });
    }

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
    if (a === '--bootstrap') { out.enabled = true; out.bundlePath = argv[++i]; } else if (a === '--bootstrap-passphrase-file') { out.passphraseFile = argv[++i]; } else if (a === '--bootstrap-tls-dir') { out.tlsDir = argv[++i]; } else if (a === '--bootstrap-config-dir') { out.configDir = argv[++i]; }
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
  const { consumer } = require('business/src/bootstrap');
  console.log('[bootstrap] starting --bootstrap from ' + args.bundlePath);
  const result = await consumer.consume({
    bundlePath: args.bundlePath,
    passphraseFile: args.passphraseFile,
    configDir: args.configDir,
    tlsDir: args.tlsDir,
    log: (m) => console.log('[bootstrap] ' + m)
  });
  console.log('[bootstrap] joined cluster as ' + result.coreId);
  console.log('[bootstrap] override-config: ' + result.overridePath);
  console.log('[bootstrap] continuing into normal startup ...');
}
