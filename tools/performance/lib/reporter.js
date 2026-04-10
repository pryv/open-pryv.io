/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import fs from 'node:fs';
import path from 'node:path';
import { getSystemInfo } from './system-info.js';

const resultsDir = new URL('../results/', import.meta.url).pathname;

/**
 * Compute statistics from an array of request results.
 * Each result should have { elapsed, error? }
 */
export function computeStats (results, durationMs) {
  const successful = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);
  const latencies = successful.map(r => r.elapsed).sort((a, b) => a - b);

  const durationS = durationMs / 1000;

  return {
    totalRequests: results.length,
    successfulRequests: successful.length,
    failedRequests: failed.length,
    requestsPerSecond: +(successful.length / durationS).toFixed(2),
    latency: latencies.length > 0
      ? {
          min: +latencies[0].toFixed(2),
          p50: +percentile(latencies, 50).toFixed(2),
          p95: +percentile(latencies, 95).toFixed(2),
          p99: +percentile(latencies, 99).toFixed(2),
          max: +latencies[latencies.length - 1].toFixed(2),
          avg: +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)
        }
      : null,
    errors: summarizeErrors(failed)
  };
}

function percentile (sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function summarizeErrors (failed) {
  if (failed.length === 0) return {};
  const counts = {};
  for (const r of failed) {
    const key = r.error || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Write a single combined result file (JSON + markdown) for an entire scenario run.
 * `entries` is an array of { subScenario, stats, extra }.
 */
export function writeScenarioResult (config, scenario, entries, resources, storage, storageFromBaseline) {
  const system = getSystemInfo();
  const ts = new Date().toISOString();
  const label = config.label || `c${config.concurrency}-d${config.duration}`;

  const result = {
    meta: {
      timestamp: ts,
      scenario,
      label,
      duration: config.duration,
      concurrency: config.concurrency
    },
    system,
    config: {
      target: config.target,
      profile: config.profile || null,
      ...config.serverConfig
    },
    runs: entries.map(e => ({
      subScenario: e.subScenario,
      ...e.extra,
      results: e.stats
    })),
    resources: resources || null,
    storage: storage || null,
    storageFromBaseline: storageFromBaseline || null
  };

  const tsSlug = ts.replace(/[:.]/g, '-').slice(0, 19);
  const name = `${tsSlug}-${scenario}-${slugify(label)}`;
  const jsonPath = path.join(resultsDir, name + '.json');
  const mdPath = path.join(resultsDir, name + '.md');

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(mdPath, toSummaryMarkdown(result) + '\n');

  return { jsonPath, mdPath };
}

function fmtBytes (bytes) {
  if (bytes === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = Math.abs(bytes);
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)}${units[i]}`;
}

function fmtBytesDelta (bytes) {
  const sign = bytes >= 0 ? '+' : '-';
  return sign + fmtBytes(Math.abs(bytes));
}

function slugify (s) {
  return s.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function toSummaryMarkdown (result) {
  const { meta, system, runs } = result;
  const lines = [];

  lines.push(`# Benchmark: ${meta.scenario}`);
  lines.push('');
  lines.push(`**Date:** ${meta.timestamp}  `);
  lines.push(`**Duration:** ${meta.duration}s | **Concurrency:** ${meta.concurrency}  `);
  lines.push(`**Target:** ${result.config.target} | **Profile:** ${result.config.profile || 'n/a'}`);
  lines.push('');

  // Server config (engines, audit, integrity)
  const cfg = result.config;
  lines.push('## Server Config');
  if (cfg.engines) {
    lines.push(`- **Base storage:** ${cfg.engines.base || 'n/a'}`);
    lines.push(`- **Platform storage:** ${cfg.engines.platform || 'n/a'}`);
    lines.push(`- **Series storage:** ${cfg.engines.series || 'n/a'}`);
    lines.push(`- **File storage:** ${cfg.engines.file || 'n/a'}`);
    lines.push(`- **Audit storage:** ${cfg.engines.audit || 'n/a'}`);
  }
  if (cfg.audit != null) lines.push(`- **Audit:** ${cfg.audit ? 'ON' : 'OFF'}`);
  if (cfg.integrity != null) lines.push(`- **Integrity:** ${JSON.stringify(cfg.integrity)}`);
  if (cfg.clusterWorkers != null) lines.push(`- **API workers:** ${cfg.clusterWorkers}`);
  lines.push('');

  lines.push('## System');
  lines.push(`- **CPU:** ${system.cpuModel} (${system.cpuCores} cores)`);
  lines.push(`- **Memory:** ${system.memoryTotal}`);
  lines.push(`- **OS:** ${system.os} (${system.arch})`);
  lines.push(`- **Node:** ${system.nodeVersion}`);
  lines.push(`- **Version:** ${system.version} (${system.gitCommit})`);
  lines.push('');

  // Summary table
  lines.push('## Results');
  lines.push('');
  lines.push('| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');

  for (const run of runs) {
    const s = run.results;
    const lat = s.latency;
    lines.push(`| ${run.subScenario} | ${s.requestsPerSecond} | ${lat?.p50 ?? '-'} | ${lat?.p95 ?? '-'} | ${lat?.p99 ?? '-'} | ${lat?.max ?? '-'} | ${s.successfulRequests} | ${s.failedRequests} |`);
  }
  lines.push('');

  // Errors section (only if any)
  const runsWithErrors = runs.filter(r => r.results.failedRequests > 0);
  if (runsWithErrors.length > 0) {
    lines.push('## Errors');
    lines.push('');
    for (const run of runsWithErrors) {
      lines.push(`### ${run.subScenario}`);
      for (const [msg, count] of Object.entries(run.results.errors)) {
        lines.push(`- ${msg}: ${count}`);
      }
      lines.push('');
    }
  }

  // Resources section
  if (result.resources?.peak) {
    const r = result.resources;
    lines.push(`## Resources (${r.processCount || 'n/a'} processes)`);
    lines.push('');
    lines.push('| Metric | Peak | Avg |');
    lines.push('|--------|------|-----|');
    lines.push(`| RSS (MB) | ${r.peak.rssMb} | ${r.avg.rssMb} |`);
    lines.push(`| CPU (%) | ${r.peak.cpuPercent} | ${r.avg.cpuPercent} |`);
    lines.push(`| Samples | ${r.samples.length} | |`);
    lines.push('');
  }

  // Storage section — from clean baseline (if available)
  if (result.storageFromBaseline) {
    lines.push('## Storage (from clean baseline)');
    lines.push('');
    lines.push('| Engine | Clean DB | After run | Total growth |');
    lines.push('|--------|----------|-----------|-------------|');
    for (const [key, val] of Object.entries(result.storageFromBaseline)) {
      if (key === 'syslogLines') {
        lines.push(`| ${key} | ${val.before} | ${val.after} | +${val.delta} |`);
      } else {
        lines.push(`| ${key} | ${fmtBytes(val.before)} | ${fmtBytes(val.after)} | ${fmtBytesDelta(val.delta)} |`);
      }
    }
    lines.push('');
  }

  // Storage section — this run only
  if (result.storage) {
    lines.push('## Storage (this run)');
    lines.push('');
    lines.push('| Engine | Before | After | Delta |');
    lines.push('|--------|--------|-------|-------|');
    for (const [key, val] of Object.entries(result.storage)) {
      if (key === 'syslogLines') {
        lines.push(`| ${key} | ${val.before} | ${val.after} | +${val.delta} |`);
      } else {
        lines.push(`| ${key} | ${fmtBytes(val.before)} | ${fmtBytes(val.after)} | ${fmtBytesDelta(val.delta)} |`);
      }
    }
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('_Add observations here._');

  return lines.join('\n');
}

/**
 * Print a summary table to the console.
 */
export function printScenarioSummary (scenario, entries) {
  console.log(`\n=== ${scenario} ===`);
  const maxName = Math.max(...entries.map(e => e.subScenario.length), 14);
  const hdr = 'Sub-scenario'.padEnd(maxName) + '  Req/s    p50    p95    p99    max   OK   Fail';
  console.log('  ' + hdr);
  console.log('  ' + '─'.repeat(hdr.length));
  for (const e of entries) {
    const s = e.stats;
    const lat = s.latency;
    const row = e.subScenario.padEnd(maxName) +
      String(s.requestsPerSecond).padStart(7) +
      (lat ? String(lat.p50).padStart(7) : '      -') +
      (lat ? String(lat.p95).padStart(7) : '      -') +
      (lat ? String(lat.p99).padStart(7) : '      -') +
      (lat ? String(lat.max).padStart(7) : '      -') +
      String(s.successfulRequests).padStart(5) +
      String(s.failedRequests).padStart(6);
    console.log('  ' + row);
  }
}

/**
 * Write a sweep result — one scenario at multiple concurrency levels.
 */
export function writeSweepResult (config, scenario, sweepResults) {
  const system = getSystemInfo();
  const ts = new Date().toISOString();
  const levels = sweepResults.map(s => s.concurrency);
  const label = config.label || `sweep-${levels.join('-')}-d${config.duration}`;

  const result = {
    meta: {
      timestamp: ts,
      scenario,
      label,
      type: 'sweep',
      duration: config.duration,
      concurrencyLevels: levels
    },
    system,
    config: {
      target: config.target,
      profile: config.profile || null,
      ...config.serverConfig
    },
    sweep: sweepResults.map(sr => ({
      concurrency: sr.concurrency,
      resources: sr.resources,
      runs: sr.entries.map(e => ({
        subScenario: e.subScenario,
        ...e.extra,
        results: e.stats
      }))
    }))
  };

  const tsSlug = ts.replace(/[:.]/g, '-').slice(0, 19);
  const name = `${tsSlug}-${scenario}-${slugify(label)}`;
  const jsonPath = path.join(resultsDir, name + '.json');
  const mdPath = path.join(resultsDir, name + '.md');

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(mdPath, toSweepMarkdown(result) + '\n');

  return { jsonPath, mdPath };
}

function toSweepMarkdown (result) {
  const { meta, system, sweep } = result;
  const lines = [];

  lines.push(`# Concurrency Sweep: ${meta.scenario}`);
  lines.push('');
  lines.push(`**Date:** ${meta.timestamp}  `);
  lines.push(`**Duration:** ${meta.duration}s per level  `);
  lines.push(`**Levels:** ${meta.concurrencyLevels.join(', ')}  `);
  lines.push(`**Target:** ${result.config.target} | **Profile:** ${result.config.profile || 'n/a'}`);
  lines.push('');

  // Server config
  const cfg = result.config;
  lines.push('## Server Config');
  if (cfg.engines) {
    lines.push(`- **Base storage:** ${cfg.engines.base || 'n/a'}`);
    lines.push(`- **Platform storage:** ${cfg.engines.platform || 'n/a'}`);
  }
  if (cfg.audit != null) lines.push(`- **Audit:** ${cfg.audit ? 'ON' : 'OFF'}`);
  if (cfg.integrity != null) lines.push(`- **Integrity:** ${JSON.stringify(cfg.integrity)}`);
  if (cfg.clusterWorkers != null) lines.push(`- **API workers:** ${cfg.clusterWorkers}`);
  lines.push('');

  lines.push('## System');
  lines.push(`- **CPU:** ${system.cpuModel} (${system.cpuCores} cores)`);
  lines.push(`- **Memory:** ${system.memoryTotal}`);
  lines.push(`- **Node:** ${system.nodeVersion} | **Version:** ${system.version} (${system.gitCommit})`);
  lines.push('');

  // Collect all unique sub-scenarios
  const subScenarios = [...new Set(sweep.flatMap(s => s.runs.map(r => r.subScenario)))];

  // One table per sub-scenario showing concurrency vs throughput/latency
  for (const sub of subScenarios) {
    lines.push(`## ${sub}`);
    lines.push('');
    lines.push('| Concurrency | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | RSS peak (MB) | Fail |');
    lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|');

    for (const level of sweep) {
      const run = level.runs.find(r => r.subScenario === sub);
      if (!run) continue;
      const s = run.results;
      const lat = s.latency;
      const rss = level.resources?.peak?.rssMb ?? '-';
      lines.push(`| ${level.concurrency} | ${s.requestsPerSecond} | ${lat?.p50 ?? '-'} | ${lat?.p95 ?? '-'} | ${lat?.p99 ?? '-'} | ${lat?.max ?? '-'} | ${rss} | ${s.failedRequests} |`);
    }
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('_Add observations here._');

  return lines.join('\n');
}

/**
 * Print sweep summary to console — throughput vs concurrency.
 */
export function printSweepSummary (scenario, sweepResults) {
  const subScenarios = [...new Set(sweepResults.flatMap(s => s.entries.map(e => e.subScenario)))];

  console.log(`\n╔══ Sweep Summary: ${scenario} ══╗`);
  for (const sub of subScenarios) {
    console.log(`\n  ${sub}:`);
    console.log('  Concurrency  Req/s    p50    p95    max');
    console.log('  ' + '─'.repeat(45));
    for (const level of sweepResults) {
      const entry = level.entries.find(e => e.subScenario === sub);
      if (!entry) continue;
      const s = entry.stats;
      const lat = s.latency;
      const row = String(level.concurrency).padStart(11) +
        String(s.requestsPerSecond).padStart(7) +
        (lat ? String(lat.p50).padStart(7) : '      -') +
        (lat ? String(lat.p95).padStart(7) : '      -') +
        (lat ? String(lat.max).padStart(7) : '      -');
      console.log('  ' + row);
    }
  }
}

/**
 * Write a full run result — all scenarios in one file.
 * `allScenarios` is an array of { scenario, entries, resources }.
 */
export function writeFullResult (config, allScenarios, totalStorage, totalFromBaseline) {
  const system = getSystemInfo();
  const ts = new Date().toISOString();
  const label = config.label || `full-c${config.concurrency}-d${config.duration}`;

  const result = {
    meta: {
      timestamp: ts,
      type: 'full',
      label,
      duration: config.duration,
      concurrency: config.concurrency,
      scenarios: allScenarios.map(s => s.scenario)
    },
    system,
    config: {
      target: config.target,
      profile: config.profile || null,
      ...config.serverConfig
    },
    scenarios: allScenarios.map(sc => ({
      scenario: sc.scenario,
      resources: sc.resources,
      storage: sc.storage || null,
      runs: sc.entries.map(e => ({
        subScenario: e.subScenario,
        ...e.extra,
        results: e.stats
      }))
    })),
    totalStorage: totalStorage || null,
    totalStorageFromBaseline: totalFromBaseline || null
  };

  const tsSlug = ts.replace(/[:.]/g, '-').slice(0, 19);
  const name = `${tsSlug}-full-${slugify(label)}`;
  const jsonPath = path.join(resultsDir, name + '.json');
  const mdPath = path.join(resultsDir, name + '.md');

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(mdPath, toFullMarkdown(result) + '\n');

  return { jsonPath, mdPath };
}

function toFullMarkdown (result) {
  const { meta, system } = result;
  const lines = [];

  lines.push('# Full Benchmark Run');
  lines.push('');
  lines.push(`**Date:** ${meta.timestamp}  `);
  lines.push(`**Duration:** ${meta.duration}s per scenario | **Concurrency:** ${meta.concurrency}  `);
  lines.push(`**Target:** ${result.config.target} | **Profile:** ${result.config.profile || 'n/a'}`);
  lines.push('');

  // Server config
  const cfg = result.config;
  lines.push('## Server Config');
  if (cfg.engines) {
    lines.push(`- **Base storage:** ${cfg.engines.base || 'n/a'} | **Platform:** ${cfg.engines.platform || 'n/a'} | **Series:** ${cfg.engines.series || 'n/a'} | **Audit:** ${cfg.engines.audit || 'n/a'}`);
  }
  if (cfg.audit != null) lines.push(`- **Audit active:** ${cfg.audit ? 'ON' : 'OFF'} | **Integrity:** ${JSON.stringify(cfg.integrity) || 'n/a'}`);
  if (cfg.clusterWorkers != null) lines.push(`- **API workers:** ${cfg.clusterWorkers}`);
  lines.push('');

  lines.push('## System');
  lines.push(`- **CPU:** ${system.cpuModel} (${system.cpuCores} cores) | **Memory:** ${system.memoryTotal}`);
  lines.push(`- **Node:** ${system.nodeVersion} | **Version:** ${system.version} (${system.gitCommit})`);
  lines.push('');

  // Grand summary table — one row per sub-scenario across all scenarios
  lines.push('## Summary');
  lines.push('');
  lines.push('| Scenario | Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');

  for (const sc of result.scenarios) {
    for (const run of sc.runs) {
      const s = run.results;
      const lat = s.latency;
      lines.push(`| ${sc.scenario} | ${run.subScenario} | ${s.requestsPerSecond} | ${lat?.p50 ?? '-'} | ${lat?.p95 ?? '-'} | ${lat?.p99 ?? '-'} | ${lat?.max ?? '-'} | ${s.successfulRequests} | ${s.failedRequests} |`);
    }
  }
  lines.push('');

  // Per-scenario detail sections
  for (const sc of result.scenarios) {
    lines.push(`## ${sc.scenario}`);
    lines.push('');
    lines.push('| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const run of sc.runs) {
      const s = run.results;
      const lat = s.latency;
      lines.push(`| ${run.subScenario} | ${s.requestsPerSecond} | ${lat?.p50 ?? '-'} | ${lat?.p95 ?? '-'} | ${lat?.p99 ?? '-'} | ${lat?.max ?? '-'} | ${s.successfulRequests} | ${s.failedRequests} |`);
    }
    if (sc.resources?.peak) {
      lines.push(`\nResources: peak RSS=${sc.resources.peak.rssMb}MB, peak CPU=${sc.resources.peak.cpuPercent}%`);
    }
    lines.push('');
  }

  // Storage from clean baseline
  if (result.totalStorageFromBaseline) {
    lines.push('## Storage (from clean baseline)');
    lines.push('');
    lines.push('| Engine | Clean DB | After all | Total growth |');
    lines.push('|--------|----------|-----------|-------------|');
    for (const [key, val] of Object.entries(result.totalStorageFromBaseline)) {
      if (key === 'syslogLines') {
        lines.push(`| ${key} | ${val.before} | ${val.after} | +${val.delta} |`);
      } else {
        lines.push(`| ${key} | ${fmtBytes(val.before)} | ${fmtBytes(val.after)} | ${fmtBytesDelta(val.delta)} |`);
      }
    }
    lines.push('');
  }

  // Storage this run
  if (result.totalStorage) {
    lines.push('## Storage (benchmark run only)');
    lines.push('');
    lines.push('| Engine | Before | After | Delta |');
    lines.push('|--------|--------|-------|-------|');
    for (const [key, val] of Object.entries(result.totalStorage)) {
      if (key === 'syslogLines') {
        lines.push(`| ${key} | ${val.before} | ${val.after} | +${val.delta} |`);
      } else {
        lines.push(`| ${key} | ${fmtBytes(val.before)} | ${fmtBytes(val.after)} | ${fmtBytesDelta(val.delta)} |`);
      }
    }
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('_Add observations here._');

  return lines.join('\n');
}

/**
 * Print full run summary to console.
 */
export function printFullSummary (allScenarios) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║            Full Run Summary                  ║');
  console.log('╠══════════════════════════════════════════════╣');
  for (const sc of allScenarios) {
    for (const e of sc.entries) {
      const s = e.stats;
      const lat = s.latency;
      const name = `${sc.scenario}/${e.subScenario}`;
      const rps = String(s.requestsPerSecond).padStart(7);
      const p50 = lat ? String(lat.p50).padStart(7) : '      -';
      const p95 = lat ? String(lat.p95).padStart(7) : '      -';
      console.log(`  ${name.padEnd(45)} ${rps} req/s  p50=${p50}  p95=${p95}`);
    }
  }
  console.log('╚══════════════════════════════════════════════╝');
}
