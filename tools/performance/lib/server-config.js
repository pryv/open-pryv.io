/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import fs from 'node:fs';
import path from 'node:path';

const scRoot = new URL('../../..', import.meta.url).pathname;

/**
 * Read storage engine, audit, and integrity config from service-core config files.
 * Works for local runs only (reads YAML config on disk).
 */
export function readServerConfig () {
  const result = {
    engines: { base: 'unknown', platform: 'unknown', series: 'unknown', file: 'unknown', audit: 'unknown' },
    audit: null,
    integrity: null,
    clusterWorkers: null
  };

  try {
    const defaultYml = fs.readFileSync(path.join(scRoot, 'config/default-config.yml'), 'utf8');

    // storage engines
    result.engines.base = yamlValue(defaultYml, /storages:[\s\S]*?base:\s*\n\s+engine:\s*(\S+)/);
    result.engines.platform = yamlValue(defaultYml, /storages:[\s\S]*?platform:\s*\n\s+engine:\s*(\S+)/);
    result.engines.series = yamlValue(defaultYml, /storages:[\s\S]*?series:\s*\n\s+engine:\s*(\S+)/);
    result.engines.file = yamlValue(defaultYml, /storages:[\s\S]*?file:\s*\n\s+engine:\s*(\S+)/);
    result.engines.audit = yamlValue(defaultYml, /storages:[\s\S]*?audit:\s*\n\s+engine:\s*(\S+)/);

    // audit active
    const auditMatch = defaultYml.match(/audit:\s*\n\s+active:\s*(true|false)/);
    if (auditMatch) result.audit = auditMatch[1] === 'true';

    // integrity
    const integritySection = defaultYml.match(/integrity:\s*\n\s+isActive:\s*\n((?:\s+\w+:\s*(?:true|false)\n?)+)/);
    if (integritySection) {
      result.integrity = {};
      for (const m of integritySection[1].matchAll(/(\w+):\s*(true|false)/g)) {
        result.integrity[m[1]] = m[2] === 'true';
      }
    }

    // cluster workers
    const workersMatch = defaultYml.match(/cluster:\s*\n\s+apiWorkers:\s*(\d+)/);
    if (workersMatch) result.clusterWorkers = parseInt(workersMatch[1], 10);

    // override-config.yml (highest priority, like @pryv/boiler)
    const overridePath = path.join(scRoot, 'config/override-config.yml');
    if (fs.existsSync(overridePath)) {
      const overrideYml = fs.readFileSync(overridePath, 'utf8');
      for (const key of ['base', 'platform', 'series', 'file', 'audit']) {
        const val = yamlValue(overrideYml, new RegExp(`${key}:\\s*\\n\\s+engine:\\s*(\\S+)`));
        if (val !== 'unknown') result.engines[key] = val;
      }
    }

    // env overrides
    if (process.env.STORAGE_ENGINE) {
      result.engines.base = process.env.STORAGE_ENGINE;
    }
  } catch {
    // config not readable — running against remote, skip
  }

  return result;
}

function yamlValue (text, regex) {
  const m = text.match(regex);
  return m ? m[1] : 'unknown';
}
