#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// Compare N backup directories produced by `bin/backup.js`.
//
// Usage: backup-rt-diff.js <bundleA> <bundleB> [<bundleC> <bundleD> ...]
//
// Reads each bundle's manifest.json and compares:
//   - userManifests length (number of users backed up)
//   - per-user record counts (events, streams, accesses, etc.)
//
// Exits 0 if all bundles agree on counts; exits 1 on first divergence
// with a per-record-type breakdown.

const fs = require('fs');
const path = require('path');

// `--require-nonzero a,b,...` fails the run when any listed stat is 0 for any
// user of the first bundle: bundles that all lost the same collection agree
// with each other, so parity alone cannot catch an export that drops it.
const args = process.argv.slice(2);
let requireNonzero = [];
const rnIdx = args.indexOf('--require-nonzero');
if (rnIdx !== -1) {
  requireNonzero = (args[rnIdx + 1] || '').split(',').filter(Boolean);
  args.splice(rnIdx, 2);
}

if (args.length < 2) {
  console.error('Usage: backup-rt-diff.js [--require-nonzero stat1,stat2] <bundleA> <bundleB> [<bundleC> ...]');
  process.exit(2);
}

const bundles = args;
const manifests = bundles.map(dir => {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) {
    console.error(`MISSING: ${p}`);
    process.exit(2);
  }
  return { dir, manifest: JSON.parse(fs.readFileSync(p, 'utf8')) };
});

let divergences = 0;
const report = [];

function fmt (label, values) {
  return `  ${label.padEnd(28)} ` + values.map(v => String(v).padStart(8)).join(' | ');
}

// User-count check (manifest.users is the canonical field per bin/backup.js)
const userCounts = manifests.map(m => m.manifest.users?.length || 0);
report.push(fmt('users.length', userCounts));
if (new Set(userCounts).size > 1) divergences++;

// Build a per-user stats comparison.
const usersByName = manifests.map(m => {
  const byName = {};
  for (const u of m.manifest.users || []) {
    byName[u.username || u.userId] = u;
  }
  return byName;
});

const refUsernames = Object.keys(usersByName[0]);
for (const username of refUsernames) {
  report.push('');
  report.push(`USER: ${username}`);
  const userEntries = usersByName.map(m => m[username] || null);
  if (userEntries.some(u => u == null)) {
    divergences++;
    report.push(`  ! missing in: ${userEntries.map((u, i) => u == null ? path.basename(bundles[i]) : null).filter(Boolean).join(', ')}`);
    continue;
  }
  // Compare stats fields per record type
  const statsFields = new Set();
  for (const u of userEntries) {
    for (const k of Object.keys(u.stats || {})) {
      statsFields.add(k);
    }
  }
  for (const field of [...statsFields].sort()) {
    const vals = userEntries.map(u => u.stats?.[field] !== undefined ? u.stats[field] : '-');
    report.push(fmt('stats.' + field, vals));
    const numericVals = vals.filter(v => typeof v === 'number');
    if (new Set(numericVals).size > 1) divergences++;
  }
}

for (const u of manifests[0].manifest.users || []) {
  for (const stat of requireNonzero) {
    if (!(u.stats?.[stat] > 0)) {
      divergences++;
      report.push(`  ! ${u.username || u.userId}: stats.${stat} is ${u.stats?.[stat] ?? 'absent'} in ${path.basename(bundles[0])}, expected > 0`);
    }
  }
}

// Content check: equal counts can still hide altered records, so compare the
// records themselves. Each user directory is reduced to one digest per
// collection (chunks merged, records canonicalised and sorted, attachment
// files hashed by name), and the digests must match across every bundle.
const zlib = require('zlib');
const crypto = require('crypto');

// A null field and an absent one carry the same meaning, and engines differ
// on which they write (PG exports `headId: null` on accesses, SQLite omits it),
// so null-valued keys are dropped before comparing.
function canonical (value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter(k => value[k] !== null).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function listFiles (dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(dir, relPath));
    else out.push(relPath);
  }
  return out;
}

function collectionDigests (userDir) {
  const records = {};
  for (const rel of listFiles(userDir)) {
    if (rel === 'user-manifest.json') continue;
    const top = rel.split(path.sep)[0];
    const file = path.join(userDir, rel);
    if (top === 'attachments') {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      (records.attachments ||= []).push(path.basename(rel) + ':' + hash);
      continue;
    }
    const collection = top.replace(/\.jsonl(\.gz)?$/, '');
    const raw = rel.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file);
    for (const line of raw.toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      (records[collection] ||= []).push(canonical(JSON.parse(line)));
    }
  }
  const digests = {};
  for (const [collection, list] of Object.entries(records)) {
    list.sort();
    digests[collection] = { list, hash: crypto.createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12) };
  }
  return digests;
}

for (const username of refUsernames) {
  const perBundle = manifests.map((m, i) => {
    const u = usersByName[i][username];
    return u ? collectionDigests(path.join(m.dir, 'users', u.userId)) : {};
  });
  const collections = new Set(perBundle.flatMap(d => Object.keys(d)));
  report.push('');
  report.push(`CONTENT: ${username}`);
  for (const collection of [...collections].sort()) {
    const hashes = perBundle.map(d => d[collection]?.hash || '-');
    report.push(fmt(collection, hashes));
    if (new Set(hashes).size > 1) {
      divergences++;
      const ref = perBundle[0][collection]?.list || [];
      perBundle.forEach((d, i) => {
        if (i === 0 || d[collection]?.hash === perBundle[0][collection]?.hash) return;
        const other = d[collection]?.list || [];
        const onlyRef = ref.filter(r => !other.includes(r)).slice(0, 2);
        const onlyOther = other.filter(r => !ref.includes(r)).slice(0, 2);
        report.push(`    ${path.basename(bundles[0])} only: ${onlyRef.join(' ').slice(0, 400)}`);
        report.push(`    ${path.basename(bundles[i])} only: ${onlyOther.join(' ').slice(0, 400)}`);
      });
    }
  }
}

const header = '  ' + ''.padEnd(28) + ' ' + bundles.map(b => path.basename(b).padStart(8)).join(' | ');
console.log(header);
console.log('  ' + '-'.repeat(header.length));
console.log(report.join('\n'));
console.log('');

if (divergences > 0) {
  console.log(`✗ ${divergences} divergence(s) across ${bundles.length} bundles`);
  process.exit(1);
}
console.log(`✓ all ${bundles.length} bundles agree on counts and content`);
process.exit(0);
