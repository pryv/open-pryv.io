/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Pattern C test helpers for api-server
 * Loaded by .mocharc.js for node tests
 *
 * Environment variables for test modes:
 * - DISABLE_INTEGRITY_CHECK=1  : per-test opt-out (reg-multicore, default-streams, …)
 * - MOCHA_PARALLEL=1           : Parallel mode (also disables caching, cluster_kv IPC,
 *                                and per-test platform/usersIndex integrity hooks —
 *                                see helpers-base.ts getMochaHooks for the latter).
 * - PATTERN_C_AUDIT=1          : Enable audit functionality
 */

const base = require('./helpers-base.ts');

// Test mode flags from environment
const disableIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK === '1';
const isParallelMode = process.env.MOCHA_PARALLEL === '1';
const isAuditMode = process.env.PATTERN_C_AUDIT === '1';

// Build test config based on environment
const testConfig: any = {};
// Override storage engines via STORAGE_ENGINE env var (e.g. 'postgresql')
if (process.env.STORAGE_ENGINE) {
  const eng = process.env.STORAGE_ENGINE;
  // Do NOT override `platform.engine` here. rqlite is the only
  // supported platform engine; the PG + Mongo PlatformDB impls are
  // intentionally incomplete (B-2026-05-21-1). Sequential matrices got
  // away with the override because the storages barrel always inits
  // early enough that the default-config value (`rqlite`) wins.
  // Parallel mode's per-worker `beforeAll` setup pushes
  // injectTestConfig BEFORE first barrel init, exposing the latent
  // broken PG/Mongo PlatformDB.
  testConfig.storages = {
    base: { engine: eng },
    series: { engine: eng === 'postgresql' ? 'postgresql' : 'influxdb' },
    file: { engine: 'filesystem' },
    audit: { engine: eng === 'postgresql' ? 'postgresql' : 'sqlite' }
  };
}

if (isAuditMode) {
  testConfig.audit = {
    active: true,
    storage: {
      filter: {
        methods: {
          include: ['all'],
          exclude: []
        }
      }
    }
  };
  testConfig.syslog = {
    filter: {
      methods: {
        exclude: ['all'],
        include: []
      }
    }
  };
}

// Initialize base helpers
base.init({
  testConfig,
  // All API methods for api-server tests
  methods: [
    'events', 'streams', 'service', 'auth/login', 'auth/register',
    'accesses', 'account', 'profile', 'webhooks', 'utility', 'mfa'
  ]
});

// Export mocha hooks. The per-test platform/usersIndex integrity hooks are
// skipped in parallel mode pending the cleanup-asymmetry investigation
// (platform DB vs users repository drift by 1 per test under MOCHA_PARALLEL=1).
// The clean()-time integrityFinalCheck on events + accesses runs in both modes.
const mochaHooks = base.getMochaHooks(disableIntegrityCheck || isParallelMode);
export { mochaHooks };
