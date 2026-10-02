/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The seriesStorage engine for a test run.
 *
 * Follows the base engine by default, but honours an explicit
 * `storages__series__engine` environment override so a run can pair a base
 * engine with another series engine (the `test-pg-influx` /
 * `test-sqlite-influx` recipes pair PostgreSQL or SQLite with InfluxDB).
 *
 * Same reason as `resolveTestFileEngine`: the helpers force the engine into
 * the memory nconf scope, which would otherwise shadow the env source that a
 * forked child server reads, and the two sides would use different series
 * engines.
 */
let noticeShown = false;

export function resolveTestSeriesEngine (baseEngine: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  const override = env.storages__series__engine;
  if (override == null || override === '') return baseEngine;
  // An exported variable would otherwise move every suite to another series
  // engine without any sign in the output.
  if (!noticeShown) {
    noticeShown = true;
    console.log(`[test-helpers] series engine: ${override} (from storages__series__engine)`);
  }
  return override;
}

export default { resolveTestSeriesEngine };
