/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The auditStorage engine for a test run that forces one.
 *
 * Follows the base engine by default, but honours an explicit
 * `storages__audit__engine` environment override so a run can pair a base
 * engine with the other audit engine (the `test-sqlite-pg-audit` recipe).
 *
 * Same reason as `resolveTestFileEngine`: the helpers force the engine into
 * the memory nconf scope, which would otherwise shadow the env source that a
 * forked child server reads, and the two sides would use different audit
 * engines.
 */
export function resolveTestAuditEngine (baseEngine: string | undefined, env: Record<string, string | undefined> = process.env): string {
  return env.storages__audit__engine || (baseEngine === 'postgresql' ? 'postgresql' : 'sqlite');
}

export default { resolveTestAuditEngine };
