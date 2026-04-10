#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Compare two benchmark result files.
 *
 * Usage:
 *   node bin/compare.js <result-A.json> <result-B.json> [--output file.md]
 *
 * Supports: single scenario, full run, and sweep result files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const resultsDir = new URL('../results/', import.meta.url).pathname;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' }
  },
  allowPositionals: true,
  strict: false
});

if (values.help || positionals.length < 2) {
  console.log(`
Usage: node bin/compare.js <result-A.json> <result-B.json> [--output file.md]

Compares two benchmark result files and shows:
- Throughput delta (req/s change and %)
- Latency delta (p50, p95, p99)
- Storage delta
- Config differences

Files can be full paths or names in the results/ directory.
`.trim());
  process.exit(positionals.length < 2 ? 1 : 0);
}

// resolve file paths
function resolveFile (f) {
  if (fs.existsSync(f)) return f;
  const inResults = path.join(resultsDir, f);
  if (fs.existsSync(inResults)) return inResults;
  // try adding .json
  if (fs.existsSync(f + '.json')) return f + '.json';
  if (fs.existsSync(inResults + '.json')) return inResults + '.json';
  console.error(`File not found: ${f}`);
  process.exit(1);
}

const fileA = resolveFile(positionals[0]);
const fileB = resolveFile(positionals[1]);
const resultA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
const resultB = JSON.parse(fs.readFileSync(fileB, 'utf8'));

// extract runs from any result type (single, full, sweep)
function extractRuns (result) {
  if (result.scenarios) {
    // full run
    const runs = [];
    for (const sc of result.scenarios) {
      for (const run of sc.runs) {
        runs.push({ key: `${sc.scenario}/${run.subScenario}`, ...run.results });
      }
    }
    return runs;
  }
  if (result.sweep) {
    // sweep — flatten
    const runs = [];
    for (const level of result.sweep) {
      for (const run of level.runs) {
        runs.push({ key: `c${level.concurrency}/${run.subScenario}`, ...run.results });
      }
    }
    return runs;
  }
  if (result.runs) {
    // single scenario
    return result.runs.map(run => ({
      key: run.subScenario,
      ...run.results
    }));
  }
  return [];
}

const runsA = extractRuns(resultA);
const runsB = extractRuns(resultB);

// build comparison
const labelA = path.basename(fileA, '.json');
const labelB = path.basename(fileB, '.json');

const lines = [];
lines.push('# Benchmark Comparison');
lines.push('');
lines.push('| | **A** | **B** |');
lines.push('|---|---|---|');
lines.push(`| File | ${labelA} | ${labelB} |`);
lines.push(`| Date | ${resultA.meta?.timestamp || 'n/a'} | ${resultB.meta?.timestamp || 'n/a'} |`);
lines.push(`| Duration | ${resultA.meta?.duration || 'n/a'}s | ${resultB.meta?.duration || 'n/a'}s |`);
lines.push(`| Concurrency | ${resultA.meta?.concurrency || 'n/a'} | ${resultB.meta?.concurrency || 'n/a'} |`);
lines.push('');

// config differences
const cfgA = resultA.config || {};
const cfgB = resultB.config || {};
const allCfgKeys = [...new Set([...Object.keys(cfgA), ...Object.keys(cfgB)])];
const cfgDiffs = allCfgKeys.filter(k => JSON.stringify(cfgA[k]) !== JSON.stringify(cfgB[k]));

if (cfgDiffs.length > 0) {
  lines.push('## Config Differences');
  lines.push('');
  lines.push('| Setting | A | B |');
  lines.push('|---------|---|---|');
  for (const k of cfgDiffs) {
    const va = typeof cfgA[k] === 'object' ? JSON.stringify(cfgA[k]) : String(cfgA[k] ?? 'n/a');
    const vb = typeof cfgB[k] === 'object' ? JSON.stringify(cfgB[k]) : String(cfgB[k] ?? 'n/a');
    lines.push(`| ${k} | ${va} | ${vb} |`);
  }
  lines.push('');
}

// system differences
const sysA = resultA.system || {};
const sysB = resultB.system || {};
if (sysA.version !== sysB.version || sysA.gitCommit !== sysB.gitCommit) {
  lines.push('## Version');
  lines.push('');
  lines.push(`- **A:** ${sysA.version || 'n/a'} (${sysA.gitCommit || 'n/a'})`);
  lines.push(`- **B:** ${sysB.version || 'n/a'} (${sysB.gitCommit || 'n/a'})`);
  lines.push('');
}

// throughput & latency comparison
lines.push('## Performance');
lines.push('');
lines.push('| Sub-scenario | Req/s A | Req/s B | Delta | p50 A | p50 B | p95 A | p95 B |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');

// match runs by key
const mapB = new Map(runsB.map(r => [r.key, r]));
const compared = [];

for (const a of runsA) {
  const b = mapB.get(a.key);
  if (!b) {
    lines.push(`| ${a.key} | ${a.requestsPerSecond} | - | - | ${a.latency?.p50 ?? '-'} | - | ${a.latency?.p95 ?? '-'} | - |`);
    continue;
  }
  mapB.delete(a.key);
  const rpsA = a.requestsPerSecond;
  const rpsB = b.requestsPerSecond;
  const rpsDelta = rpsB - rpsA;
  const rpsPct = rpsA > 0 ? ((rpsDelta / rpsA) * 100).toFixed(1) : 'n/a';
  const sign = rpsDelta >= 0 ? '+' : '';
  const deltaStr = `${sign}${rpsDelta.toFixed(1)} (${sign}${rpsPct}%)`;

  lines.push(`| ${a.key} | ${rpsA} | ${rpsB} | ${deltaStr} | ${a.latency?.p50 ?? '-'} | ${b.latency?.p50 ?? '-'} | ${a.latency?.p95 ?? '-'} | ${b.latency?.p95 ?? '-'} |`);
  compared.push({ key: a.key, rpsA, rpsB, rpsDelta, rpsPct: parseFloat(rpsPct) });
}

// runs only in B
for (const [key, b] of mapB) {
  lines.push(`| ${key} | - | ${b.requestsPerSecond} | - | - | ${b.latency?.p50 ?? '-'} | - | ${b.latency?.p95 ?? '-'} |`);
}
lines.push('');

// summary
if (compared.length > 0) {
  const avgPct = compared.reduce((s, c) => s + c.rpsPct, 0) / compared.length;
  const faster = compared.filter(c => c.rpsDelta > 0).length;
  const slower = compared.filter(c => c.rpsDelta < 0).length;
  const same = compared.filter(c => c.rpsDelta === 0).length;

  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Average throughput change:** ${avgPct >= 0 ? '+' : ''}${avgPct.toFixed(1)}%`);
  lines.push(`- **Faster in B:** ${faster}/${compared.length} sub-scenarios`);
  lines.push(`- **Slower in B:** ${slower}/${compared.length} sub-scenarios`);
  if (same > 0) lines.push(`- **Same:** ${same}/${compared.length} sub-scenarios`);
  lines.push('');
}

// storage comparison
function getStorage (result) {
  return result.totalStorageFromBaseline || result.storageFromBaseline || result.totalStorage || result.storage || null;
}

const storA = getStorage(resultA);
const storB = getStorage(resultB);

if (storA && storB) {
  lines.push('## Storage');
  lines.push('');
  lines.push('| Engine | Growth A | Growth B | Delta |');
  lines.push('|--------|----------|----------|-------|');
  const allKeys = [...new Set([...Object.keys(storA), ...Object.keys(storB)])];
  for (const key of allKeys) {
    const da = storA[key]?.delta ?? 0;
    const db = storB[key]?.delta ?? 0;
    const diff = db - da;
    if (key === 'syslogLines') {
      lines.push(`| ${key} | +${da} | +${db} | ${diff >= 0 ? '+' : ''}${diff} |`);
    } else {
      lines.push(`| ${key} | ${fmtBytes(da)} | ${fmtBytes(db)} | ${fmtBytesDelta(diff)} |`);
    }
  }
  lines.push('');
}

lines.push('## Notes');
lines.push('');
lines.push('_Add observations here._');

const output = lines.join('\n') + '\n';

// print to console
console.log(output);

// optionally write to file
if (values.output) {
  const outPath = values.output.endsWith('.md') ? values.output : values.output + '.md';
  fs.writeFileSync(outPath, output);
  console.log(`Written to: ${outPath}`);
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
