/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import fs from 'node:fs';

/**
 * Resource monitor — samples /proc/{pid}/stat and /proc/meminfo at intervals.
 * Linux-only; silently returns empty data on other platforms.
 */
export class ResourceMonitor {
  constructor (pid, intervalMs = 1000) {
    this.pid = pid || process.pid;
    this.intervalMs = intervalMs;
    this.samples = [];
    this._timer = null;
    this._prevCpu = null;
    this._prevTime = null;
    this._isLinux = process.platform === 'linux';
  }

  start () {
    if (!this._isLinux) return;
    this._sample(); // initial sample
    this._timer = setInterval(() => this._sample(), this.intervalMs);
  }

  stop () {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this.getReport();
  }

  _sample () {
    try {
      const ts = Date.now();

      // RSS from /proc/{pid}/status
      const status = fs.readFileSync(`/proc/${this.pid}/status`, 'utf8');
      const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
      const rssKb = rssMatch ? parseInt(rssMatch[1], 10) : 0;

      // CPU from /proc/{pid}/stat
      const stat = fs.readFileSync(`/proc/${this.pid}/stat`, 'utf8');
      const parts = stat.split(') ')[1]?.split(' ');
      // fields 11 (utime) and 12 (stime) after the closing paren
      const utime = parts ? parseInt(parts[11], 10) : 0;
      const stime = parts ? parseInt(parts[12], 10) : 0;
      const totalCpu = utime + stime;

      let cpuPercent = 0;
      if (this._prevCpu !== null) {
        const cpuDelta = totalCpu - this._prevCpu;
        const timeDelta = (ts - this._prevTime) / 1000; // seconds
        const clockTick = 100; // sysconf(_SC_CLK_TCK) = 100 on most Linux
        cpuPercent = (cpuDelta / clockTick / timeDelta) * 100;
      }
      this._prevCpu = totalCpu;
      this._prevTime = ts;

      this.samples.push({
        ts,
        rssMb: +(rssKb / 1024).toFixed(1),
        cpuPercent: +cpuPercent.toFixed(1)
      });
    } catch {
      // pid may not exist or not on linux — skip
    }
  }

  getReport () {
    if (this.samples.length === 0) {
      return { peak: null, avg: null, samples: [] };
    }

    const rssValues = this.samples.map(s => s.rssMb);
    const cpuValues = this.samples.filter(s => s.cpuPercent > 0).map(s => s.cpuPercent);

    return {
      peak: {
        rssMb: Math.max(...rssValues),
        cpuPercent: cpuValues.length > 0 ? Math.max(...cpuValues) : 0
      },
      avg: {
        rssMb: +(rssValues.reduce((a, b) => a + b, 0) / rssValues.length).toFixed(1),
        cpuPercent: cpuValues.length > 0
          ? +(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length).toFixed(1)
          : 0
      },
      samples: this.samples
    };
  }
}
