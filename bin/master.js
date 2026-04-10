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
//
// Config keys:
//   cluster.apiWorkers      — number of API workers (default: 2)
//   cluster.hfsWorkers      — number of HFS workers (default: 1, 0 = disabled)
//   cluster.previewsWorker  — enable previews worker (default: true)
//   cluster.runMigrations   — run DB migrations before forking workers (default: true)

const cluster = require('node:cluster');
const path = require('node:path');

if (cluster.isPrimary) {
  const os = require('node:os');

  // Minimal boiler init — just enough to read config
  require('@pryv/boiler').init({
    appName: 'master',
    baseFilesDir: path.resolve(__dirname, '../'),
    baseConfigDir: path.resolve(__dirname, '../config/'),
    extraConfigs: [{
      plugin: require('../config/plugins/systemStreams')
    }, {
      plugin: require('../config/plugins/core-identity')
    }]
  });

  const { getConfig, getLogger } = require('@pryv/boiler');
  const rqliteProcess = require('../storages/engines/rqlite/src/rqliteProcess');

  (async () => {
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
        log
      });
    }

    // Run DB migrations before starting services (same as runit core/run)
    const runMigrations = config.get('cluster:runMigrations') ?? true;
    if (runMigrations) {
      log('Running storage migrations...');
      const { getApplication } = require('../components/api-server/src/application');
      const app = getApplication();
      await app.initiate();
      const storageLayer = app.storageLayer;
      await storageLayer.waitForConnection();
      await storageLayer.versions.migrateIfNeeded();
      log('Storage migrations complete');
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

    // Track worker types for targeted restart
    const workerTypes = new Map(); // worker.id → 'api' | 'hfs' | 'previews'
    let shuttingDown = false;
    let apiWorkerId = 0;
    let hfsWorkerId = 0;

    // --- API workers ---
    const configuredApiWorkers = config.get('cluster:apiWorkers');
    const numApiWorkers = (configuredApiWorkers != null)
      ? configuredApiWorkers
      : Math.min(os.cpus().length, 4);

    log(`Forking ${numApiWorkers} API worker(s)`);
    for (let i = 0; i < numApiWorkers; i++) {
      forkApiWorker();
    }

    function forkApiWorker () {
      const id = apiWorkerId++;
      const worker = cluster.fork({
        PRYV_WORKER_TYPE: 'api',
        PRYV_BOILER_SUFFIX: `-w${id}`
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
        PRYV_BOILER_SUFFIX: `-hfs${id}`
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
        PRYV_BOILER_SUFFIX: `-prev${id}`
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
