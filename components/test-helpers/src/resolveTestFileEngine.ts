/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The fileStorage engine for a test run.
 *
 * Defaults to 'filesystem' (the historical test default), but honours an
 * explicit `storages__file__engine` environment override so a run can
 * exercise the PostgreSQL-backed fileStorage.
 *
 * Why this matters: both `helpers-c.ts` and `helpers-base.ts` force the
 * fileStorage engine into the **memory** nconf scope (highest priority)
 * via `config.set()` so it survives `injectTestConfig({})` resets. If
 * that forced value ignored the environment, it would shadow the boiler
 * env source (`__`-separated, lower priority) that a
 * DynamicInstanceManager-forked child server reads from `process.env` —
 * leaving the in-process fixture mall and the server-under-test on
 * different fileStorage engines (a split-brain that 404s attachment
 * fixtures). Resolving from the same env here keeps both sides in
 * agreement.
 */
export function resolveTestFileEngine (env: Record<string, string | undefined> = process.env): string {
  return env.storages__file__engine || 'filesystem';
}

export default { resolveTestFileEngine };
