/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 38 — provider-agnostic observability boot shim.
 *
 * CRITICAL: this file must be `require()`d as the very FIRST line of
 * every Node entrypoint (`bin/master.js`, `bin/api-server/server`,
 * `bin/hfs-server/server`, `bin/previews-server/server`, and any future
 * worker entrypoints). The underlying APM agents (e.g. `newrelic`)
 * must be loaded before `http` / `express` / `pg` / any other code
 * that they instrument — otherwise they silently no-op.
 *
 * Behaviour:
 *   - In `NODE_ENV=test`, return immediately. No provider is touched
 *     regardless of PlatformDB state.
 *   - If `PRYV_OBSERVABILITY_PROVIDER` is unset or empty, return
 *     immediately.
 *   - Otherwise `require()` the provider's boot module, which wraps
 *     `require('<agent-package>')` and attaches the adapter to the
 *     façade via `observability.init(adapter)`.
 *
 * Master is responsible for populating `PRYV_OBSERVABILITY_PROVIDER`
 * + any provider-specific agent env vars (e.g. NEW_RELIC_LICENSE_KEY)
 * before calling `cluster.setupPrimary({env})` so forked workers
 * inherit them in `process.env` before they even reach this shim.
 */

function activate () {
  if (process.env.NODE_ENV === 'test') {
    return { activated: false, reason: 'NODE_ENV=test' };
  }
  const providerId = process.env.PRYV_OBSERVABILITY_PROVIDER;
  if (!providerId) {
    return { activated: false, reason: 'PRYV_OBSERVABILITY_PROVIDER unset' };
  }
  try {
    // Resolve the provider's boot module under the business component.
    // Keep this require synchronous + before any other require in the
    // consuming process.
    const bootPath = '../components/business/src/observability/providers/' + providerId + '/boot';
    require(bootPath); // side effect: requires the agent + attaches adapter
    return { activated: true, providerId };
  } catch (err) {
    // Observability must never block the process from starting. Mirror
    // the cause to stderr so operators see it, but continue.
    process.stderr.write('[observability-boot] failed to activate provider "' + providerId + '": ' + err.message + '\n');
    return { activated: false, reason: 'boot-failure: ' + err.message };
  }
}

module.exports = activate();
