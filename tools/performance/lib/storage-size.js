/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { execSync } from 'node:child_process';
import path from 'node:path';

const scRoot = new URL('../../..', import.meta.url).pathname;

/**
 * Snapshot storage sizes for all database engines.
 * Returns an object with byte sizes per engine.
 */
export function snapshotStorageSizes () {
  return {
    mongodb: dirSize(path.join(scRoot, 'var-pryv/mongodb-data')),
    sqlite: dirSize(path.join(scRoot, 'var-pryv/users'), '*.db*'),
    influxdb: dirSize('/var/lib/influxdb'),
    userDirs: dirSize(path.join(scRoot, 'var-pryv/users')),
    syslogSize: fileSize('/var/log/syslog'),
    syslogLines: lineCount('/var/log/syslog')
  };
}

/**
 * Compute the delta between two snapshots.
 */
export function storageDelta (before, after) {
  const delta = {};
  for (const key of Object.keys(after)) {
    delta[key] = {
      before: before[key],
      after: after[key],
      delta: after[key] - before[key]
    };
  }
  return delta;
}

/**
 * Format a storage snapshot or delta for display.
 */
const countKeys = new Set(['syslogLines']);

export function formatStorageSizes (sizes) {
  const lines = [];
  for (const [key, value] of Object.entries(sizes)) {
    const f = countKeys.has(key) ? fmtCount : fmt;
    const fd = countKeys.has(key) ? fmtCountDelta : fmtDelta;
    if (typeof value === 'object' && value.delta !== undefined) {
      lines.push(`  ${key}: ${f(value.before)} → ${f(value.after)} (${fd(value.delta)})`);
    } else {
      lines.push(`  ${key}: ${f(value)}`);
    }
  }
  return lines.join('\n');
}

function dirSize (dirPath, pattern) {
  try {
    let cmd;
    if (pattern) {
      // sum matching files only
      cmd = `find ${dirPath} -name '${pattern}' -type f -exec stat --printf='%s\\n' {} + 2>/dev/null | awk '{s+=$1}END{print s+0}'`;
    } else {
      cmd = `du -sb ${dirPath} 2>/dev/null | awk '{print $1}'`;
    }
    const out = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

function fileSize (filePath) {
  try {
    const out = execSync(`stat --printf='%s' ${filePath} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

function lineCount (filePath) {
  try {
    const out = execSync(`wc -l < ${filePath} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function fmt (bytes) {
  if (bytes === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)}${units[i]}`;
}

function fmtDelta (bytes) {
  const sign = bytes >= 0 ? '+' : '';
  return sign + fmt(Math.abs(bytes));
}

function fmtCount (n) {
  return String(n);
}

function fmtCountDelta (n) {
  const sign = n >= 0 ? '+' : '';
  return sign + String(n);
}
