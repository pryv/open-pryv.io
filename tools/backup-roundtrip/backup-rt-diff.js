#!/usr/bin/env node
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

if (process.argv.length < 4) {
  console.error('Usage: backup-rt-diff.js <bundleA> <bundleB> [<bundleC> ...]');
  process.exit(2);
}

const bundles = process.argv.slice(2);
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

const header = '  ' + ''.padEnd(28) + ' ' + bundles.map(b => path.basename(b).padStart(8)).join(' | ');
console.log(header);
console.log('  ' + '-'.repeat(header.length));
console.log(report.join('\n'));
console.log('');

if (divergences > 0) {
  console.log(`✗ ${divergences} divergence(s) across ${bundles.length} bundles`);
  process.exit(1);
}
console.log(`✓ all ${bundles.length} bundles agree on counts`);
process.exit(0);
