/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import os from 'node:os';
import { execSync } from 'node:child_process';

export function getSystemInfo () {
  const info = {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model || 'unknown',
    cpuCores: os.cpus().length,
    memoryTotal: formatBytes(os.totalmem()),
    nodeVersion: process.version,
    platform: os.platform()
  };

  // try to get git commit
  try {
    info.gitCommit = execSync('git rev-parse --short HEAD', {
      cwd: new URL('../../..', import.meta.url).pathname,
      encoding: 'utf8',
      timeout: 5000
    }).trim();
  } catch {
    info.gitCommit = 'unknown';
  }

  // try to get service-core version
  try {
    const pkg = execSync('node -e "process.stdout.write(require(\'./package.json\').version)"', {
      cwd: new URL('../../..', import.meta.url).pathname,
      encoding: 'utf8',
      timeout: 5000
    });
    info.version = pkg;
  } catch {
    info.version = 'unknown';
  }

  return info;
}

function formatBytes (bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}
