/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require('path').dirname(__filename);
/**
 * Build the `env` object that master injects into every
 * `cluster.fork({...})` call. The underlying APM agent picks these up
 * at require() time inside the worker process.
 *
 * Returns an empty object when observability is disabled, misconfigured,
 * or the selected provider isn't `newrelic` — workers then see no
 * provider env and the boot shim no-ops.
 *
 * @param obs — output of `Platform.getObservabilityConfig()`.
 */
const path = require('path');

function buildObservabilityEnv (obs: any) {
  if (!obs || !obs.enabled) return {};
  if (obs.provider !== 'newrelic') return {};
  if (!obs.newrelic || !obs.newrelic.licenseKey) return {};
  return {
    PRYV_OBSERVABILITY_PROVIDER: 'newrelic',
    NEW_RELIC_LICENSE_KEY: obs.newrelic.licenseKey,
    NEW_RELIC_APP_NAME: obs.appName,
    NEW_RELIC_PROCESS_HOST_DISPLAY_NAME: obs.hostname,
    NEW_RELIC_LOG_LEVEL: obs.logLevel,
    // Account-side HSM is irreversible once enabled; default OFF so the
    // agent can connect to any account. Operators who have enabled
    // account-side HSM can flip this via a future observability CLI hook.
    NEW_RELIC_HIGH_SECURITY: obs.newrelic?.highSecurity === true ? 'true' : 'false',
    NEW_RELIC_HOME: path.resolve(__dirname, 'providers/newrelic')
  };
}

export { buildObservabilityEnv };