/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Build the `env` object that master injects into every
 * `cluster.fork({...})` call. The underlying APM agent picks these up
 * at require() time inside the worker process.
 *
 * Returns an empty object when observability is disabled, misconfigured,
 * or the selected provider isn't `newrelic` — workers then see no
 * provider env and the boot shim no-ops.
 *
 * @param {Object} obs — output of `Platform.getObservabilityConfig()`.
 * @returns {Object.<string, string>}
 */
const path = require('path');

function buildObservabilityEnv (obs) {
  if (!obs || !obs.enabled) return {};
  if (obs.provider !== 'newrelic') return {};
  if (!obs.newrelic || !obs.newrelic.licenseKey) return {};
  return {
    PRYV_OBSERVABILITY_PROVIDER: 'newrelic',
    NEW_RELIC_LICENSE_KEY: obs.newrelic.licenseKey,
    NEW_RELIC_APP_NAME: obs.appName,
    NEW_RELIC_PROCESS_HOST_DISPLAY_NAME: obs.hostname,
    NEW_RELIC_LOG_LEVEL: obs.logLevel,
    NEW_RELIC_HIGH_SECURITY: 'true',
    NEW_RELIC_HOME: path.resolve(__dirname, 'providers/newrelic')
  };
}

module.exports = { buildObservabilityEnv };
