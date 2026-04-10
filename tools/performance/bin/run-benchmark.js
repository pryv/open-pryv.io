#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../lib/config.js';
import { computeStats, writeScenarioResult, printScenarioSummary, writeSweepResult, printSweepSummary, writeFullResult, printFullSummary } from '../lib/reporter.js';
import { getSystemInfo } from '../lib/system-info.js';
import { readServerConfig } from '../lib/server-config.js';
import { ResourceMonitor } from '../lib/monitor.js';
import { snapshotStorageSizes, storageDelta, formatStorageSizes } from '../lib/storage-size.js';
import { execSync } from 'node:child_process';

const scenariosDir = new URL('../scenarios/', import.meta.url).pathname;

async function main () {
  const config = parseConfig(process.argv.slice(2));

  // list available scenarios
  const available = fs.readdirSync(scenariosDir)
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace('.js', ''));

  if (!config.scenario && !config.all) {
    console.log('Available scenarios:', available.join(', '));
    console.log('Use --scenario <name> to run one, or --all to run everything.');
    process.exit(1);
  }

  if (config.scenario && !available.includes(config.scenario)) {
    console.error(`Unknown scenario: ${config.scenario}`);
    console.error('Available:', available.join(', '));
    process.exit(1);
  }

  // load seed data
  let seedData = null;
  if (config.seedFile) {
    seedData = JSON.parse(fs.readFileSync(config.seedFile, 'utf8'));
  } else {
    const defaultSeedPath = path.join(scenariosDir, '..', 'datasets', 'seed-result.json');
    if (fs.existsSync(defaultSeedPath)) {
      seedData = JSON.parse(fs.readFileSync(defaultSeedPath, 'utf8'));
    }
  }

  if (!seedData) {
    console.error('No seed data found. Run the seed script first:');
    console.error('  node datasets/seed.js --target <url> --users 5');
    process.exit(1);
  }

  console.log(`Target: ${config.target}`);
  console.log(`Scenario: ${config.scenario}`);
  console.log(`Concurrency: ${config.concurrency} | Duration: ${config.duration}s`);
  console.log(`Users available: ${seedData.users.length}`);

  const system = getSystemInfo();
  console.log(`System: ${system.cpuModel} (${system.cpuCores} cores), ${system.memoryTotal} RAM`);

  // read server config (engines, audit, integrity)
  const serverConfig = readServerConfig();
  config.serverConfig = serverConfig;
  console.log(`Engines: base=${serverConfig.engines.base}, platform=${serverConfig.engines.platform}, series=${serverConfig.engines.series}, audit=${serverConfig.engines.audit}`);
  console.log(`Audit: ${serverConfig.audit ?? 'n/a'} | Integrity: ${JSON.stringify(serverConfig.integrity) || 'n/a'}`);
  console.log('');

  if (config.all) {
    await runAll(config, seedData, available);
  } else {
    const scenarioModule = await import(path.join(scenariosDir, config.scenario + '.js'));
    if (config.sweep) {
      await runSweep(config, seedData, scenarioModule);
    } else {
      await runSingle(config, seedData, scenarioModule);
    }
  }
}

async function runAll (config, seedData, available) {
  console.log(`Running all ${available.length} scenarios...\n`);

  const baseline = seedData.storage?.baseline;
  const sizeBefore = snapshotStorageSizes();
  const allScenarios = [];

  for (const scenarioName of available) {
    console.log('────────────────────────────────────────');
    console.log(`  Scenario: ${scenarioName}`);
    console.log('────────────────────────────────────────');

    const scSizeBefore = snapshotStorageSizes();
    const scenarioModule = await import(path.join(scenariosDir, scenarioName + '.js'));
    const monitors = startMonitors();
    const results = await scenarioModule.run(config, seedData);
    const resources = aggregateResources(monitors);
    const scSizeAfter = snapshotStorageSizes();

    const rawRuns = Array.isArray(results) ? results : [results];
    const entries = rawRuns.map(run => ({
      subScenario: run.subScenario || scenarioName,
      stats: computeStats(run.results, config.duration * 1000),
      extra: run.extra || {}
    }));

    printScenarioSummary(scenarioName, entries);
    allScenarios.push({
      scenario: scenarioName,
      entries,
      resources,
      storage: storageDelta(scSizeBefore, scSizeAfter)
    });
  }

  const sizeAfter = snapshotStorageSizes();
  const totalStorage = storageDelta(sizeBefore, sizeAfter);
  const totalFromBaseline = baseline ? storageDelta(baseline, sizeAfter) : null;

  // write combined result
  const paths = writeFullResult(config, allScenarios, totalStorage, totalFromBaseline);
  printFullSummary(allScenarios);
  console.log('\n  Storage (this run):\n' + formatStorageSizes(totalStorage));
  if (totalFromBaseline) {
    console.log('  Storage (from clean baseline):\n' + formatStorageSizes(totalFromBaseline));
  }
  console.log(`\n  Saved: ${paths.jsonPath}`);
  console.log(`         ${paths.mdPath}`);
  console.log('\nDone.');
}

async function runSingle (config, seedData, scenarioModule) {
  const baseline = seedData.storage?.baseline;
  const sizeBefore = snapshotStorageSizes();
  const monitors = startMonitors();
  const results = await scenarioModule.run(config, seedData);
  const resources = aggregateResources(monitors);
  const sizeAfter = snapshotStorageSizes();
  // delta vs benchmark start
  const storage = storageDelta(sizeBefore, sizeAfter);
  // delta vs clean baseline (if available from seed)
  const storageFromBaseline = baseline ? storageDelta(baseline, sizeAfter) : null;

  const rawRuns = Array.isArray(results) ? results : [results];
  const entries = rawRuns.map(run => ({
    subScenario: run.subScenario || config.scenario,
    stats: computeStats(run.results, config.duration * 1000),
    extra: run.extra || {}
  }));

  printScenarioSummary(config.scenario, entries);
  const paths = writeScenarioResult(config, config.scenario, entries, resources, storage, storageFromBaseline);
  console.log(`\n  Saved: ${paths.jsonPath}`);
  console.log(`         ${paths.mdPath}`);
  if (resources?.peak) {
    console.log(`  Resources: peak RSS=${resources.peak.rssMb}MB, peak CPU=${resources.peak.cpuPercent}%`);
  }
  console.log('  Storage (this run):\n' + formatStorageSizes(storage));
  if (storageFromBaseline) {
    console.log('  Storage (from clean baseline):\n' + formatStorageSizes(storageFromBaseline));
  }
  console.log('\nDone.');
}

async function runSweep (config, seedData, scenarioModule) {
  const levels = config.sweep;
  console.log(`Concurrency sweep: ${levels.join(', ')}`);
  console.log('');

  const sweepResults = [];

  for (const concurrency of levels) {
    console.log(`── Concurrency: ${concurrency} ──`);
    const runConfig = { ...config, concurrency };

    const monitors = startMonitors();
    const results = await scenarioModule.run(runConfig, seedData);
    const resources = aggregateResources(monitors);

    const rawRuns = Array.isArray(results) ? results : [results];
    const entries = rawRuns.map(run => ({
      subScenario: run.subScenario || config.scenario,
      stats: computeStats(run.results, config.duration * 1000),
      extra: run.extra || {}
    }));

    printScenarioSummary(`c=${concurrency}`, entries);
    sweepResults.push({ concurrency, entries, resources });
  }

  // write combined sweep result
  const paths = writeSweepResult(config, config.scenario, sweepResults);
  printSweepSummary(config.scenario, sweepResults);
  console.log(`\n  Saved: ${paths.jsonPath}`);
  console.log(`         ${paths.mdPath}`);
  console.log('\nDone.');
}

function startMonitors () {
  const monitors = [];
  const serverPids = findServerPids();
  for (const pid of serverPids) {
    const m = new ResourceMonitor(pid);
    m.start();
    monitors.push(m);
  }
  if (monitors.length > 0) {
    console.log(`Monitoring ${serverPids.length} processes`);
  }
  return monitors;
}

function aggregateResources (monitors) {
  if (monitors.length === 0) return null;
  const reports = monitors.map(m => m.stop());
  // sum RSS and CPU across all processes at each sample point
  const sampleCount = Math.max(...reports.map(r => r.samples.length));
  const aggregated = [];
  for (let i = 0; i < sampleCount; i++) {
    let rss = 0;
    let cpu = 0;
    for (const r of reports) {
      if (r.samples[i]) {
        rss += r.samples[i].rssMb;
        cpu += r.samples[i].cpuPercent;
      }
    }
    aggregated.push({ rssMb: +rss.toFixed(1), cpuPercent: +cpu.toFixed(1) });
  }
  const rssValues = aggregated.map(s => s.rssMb);
  const cpuValues = aggregated.filter(s => s.cpuPercent > 0).map(s => s.cpuPercent);
  return {
    processCount: monitors.length,
    peak: {
      rssMb: Math.max(...rssValues),
      cpuPercent: cpuValues.length > 0 ? Math.max(...cpuValues) : 0
    },
    avg: {
      rssMb: +(rssValues.reduce((a, b) => a + b, 0) / rssValues.length).toFixed(1),
      cpuPercent: cpuValues.length > 0 ? +(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length).toFixed(1) : 0
    },
    samples: aggregated
  };
}

function findServerPids () {
  try {
    // find all node processes related to service-core (master + workers)
    const out = execSync('pgrep -f "node.*bin/master"', { encoding: 'utf8', timeout: 3000 });
    const masterPid = out.trim().split('\n').map(Number).filter(Boolean)[0];
    if (!masterPid) return [];
    // get master + all child processes
    try {
      const children = execSync(`pgrep -P ${masterPid}`, { encoding: 'utf8', timeout: 3000 });
      const childPids = children.trim().split('\n').map(Number).filter(Boolean);
      return [masterPid, ...childPids];
    } catch {
      return [masterPid];
    }
  } catch {
    return [];
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
