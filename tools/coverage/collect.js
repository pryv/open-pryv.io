#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Coverage-aware test runner that replaces scripts/components-run for
 * coverage collection.
 *
 * Problem: components-run spawns mocha with cwd set to each component
 * directory.  Coverage tools (NYC, c8) resolve include patterns relative
 * to cwd, so `storages/**\/*.js` never matches when cwd is
 * `components/api-server/`.  Additionally, `npx mocha` adds an extra
 * process layer that prevents NODE_V8_COVERAGE from capturing files
 * loaded in the mocha process.
 *
 * Fix: this script runs mocha from the project root using
 * `node node_modules/.bin/mocha` (no npx), adjusting --require and
 * --spec paths so they resolve correctly.  Combined with
 * NODE_V8_COVERAGE, V8 captures coverage for ALL loaded files
 * including lazy-required engine implementations.
 *
 * Usage:
 *   node tools/coverage/collect.js              # all components
 *   COMPONENT=api-server node tools/coverage/collect.js
 *   STORAGE_ENGINE=postgresql node tools/coverage/collect.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const chalk = require('chalk');

const ROOT = path.resolve(__dirname, '../..');
const MOCHA_BIN = path.join(ROOT, 'node_modules', '.bin', 'mocha');
const componentsDir = path.join(ROOT, 'components');
const storagesDir = path.join(ROOT, 'storages');
const storageEngine = process.env.STORAGE_ENGINE || '';
const targetComponent = (process.env.COMPONENT && process.env.COMPONENT !== 'all')
  ? process.env.COMPONENT
  : null;

// ── Build entry list (mirrors scripts/components-run logic) ──────────

const entries = [];

for (const name of fs.readdirSync(componentsDir)) {
  const dir = path.join(componentsDir, name);
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    entries.push({ name, dir });
  }
}

if (fs.existsSync(path.join(storagesDir, 'package.json'))) {
  entries.push({ name: 'storages', dir: storagesDir });
}

const enginesDir = path.join(storagesDir, 'engines');
if (fs.existsSync(enginesDir)) {
  for (const eng of fs.readdirSync(enginesDir)) {
    const dir = path.join(enginesDir, eng);
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
    if (storageEngine && eng !== storageEngine) {
      const manifestPath = path.join(dir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.storageTypes && manifest.storageTypes.includes('baseStorage')) {
          continue;
        }
      }
    }
    entries.push({ name: `storages:${eng}`, dir });
  }
}

// ── Run mocha for each entry from project root ───────────────────────

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
});

let status = 0;

for (const entry of entries) {
  if (interrupted) break;
  if (targetComponent && entry.name !== targetComponent) continue;

  // Skip entries without test/ folder
  if (!fs.existsSync(path.join(entry.dir, 'test'))) {
    continue;
  }

  const relDir = path.relative(ROOT, entry.dir);
  const padLen = Math.max(0, (process.stdout.columns || 80) - 1 - entry.name.length);
  console.log(chalk.green(entry.name + ' ' + '-'.repeat(padLen)));

  // ── Build mocha args ──────────────────────────────────────────────

  const mochaArgs = [
    '--no-config', // don't read root .mocharc.js (we set everything via CLI)
    '--exit',
    '--reporter', 'dot',
    '--ui', 'bdd'
  ];

  // For PG coverage: after the component's --require (which inits boiler),
  // inject PG config before global.test.js before() calls ensureBarrel().
  const pgEarlyInit = (storageEngine === 'postgresql')
    ? path.join(ROOT, 'tools/coverage/pg-early-init.js')
    : null;

  // Load component .mocharc.js for require/timeout values
  const configPath = path.join(entry.dir, '.mocharc.js');
  let timeout = 10000;

  if (fs.existsSync(configPath)) {
    try {
      // Load config — glob.sync() calls inside resolve from ROOT cwd
      // which is fine (nonParallelTests will just be empty)
      const config = require(configPath);

      if (config.timeout) timeout = config.timeout;

      if (config.require) {
        let reqPath = config.require;
        // Local paths (test/helpers.js, ./test/hook.js) need adjustment
        // to resolve from project root instead of component dir
        if (reqPath.startsWith('test/') || reqPath.startsWith('./')) {
          reqPath = path.join(relDir, reqPath);
        }
        mochaArgs.push('--require', reqPath);
        // PG early init must come AFTER the component's require (which
        // initializes boiler) but BEFORE test files run.
        if (pgEarlyInit) {
          mochaArgs.push('--require', pgEarlyInit);
        }
      }
    } catch (e) {
      // Config failed to load — use defaults
      console.log(chalk.yellow(`  (config load failed: ${e.message})`));
    }
  }

  mochaArgs.push('--timeout', String(timeout));

  // Spec: test files relative to project root
  mochaArgs.push(path.join(relDir, 'test', '**', '*.test.js'));

  // ── Spawn mocha from project root ─────────────────────────────────
  // Use `node mocha` directly — NOT `npx mocha`.
  // npx adds an extra process layer that prevents NODE_V8_COVERAGE
  // from capturing files loaded in the mocha process.

  const res = spawnSync(process.execPath, [MOCHA_BIN, ...mochaArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });

  if (res.signal === 'SIGINT' || res.signal === 'SIGTERM' || res.status === 130) {
    process.exit(130);
  }

  if (res.status !== 0 && res.status !== null) {
    status += res.status;
  }
}

process.exit(interrupted ? 130 : status);
