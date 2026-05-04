/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * New Relic provider boot.
 *
 * Invoked by `bin/_observability-boot.js` as the very first require()
 * in any entrypoint process when `PRYV_OBSERVABILITY_PROVIDER=newrelic`.
 *
 * Side effects:
 *   - `require('newrelic')` — activates the agent's Express/http/etc.
 *     instrumentation. The agent reads its config from env vars the
 *     master already populated (NEW_RELIC_LICENSE_KEY,
 *     NEW_RELIC_APP_NAME, NEW_RELIC_PROCESS_HOST_DISPLAY_NAME,
 *     NEW_RELIC_LOG_LEVEL, NEW_RELIC_HIGH_SECURITY=true).
 *   - Constructs an adapter wrapping the agent handle.
 *   - Attaches the adapter to the provider-agnostic façade via
 *     `observability.init(adapter)`.
 *
 * If the `newrelic` package isn't installed (it's an
 * optionalDependency), this throws — the shim catches and logs a
 * one-line warning to stderr, and the process continues unaffected.
 */

const newrelicAgent = require('newrelic');
const { createAdapter } = require('./adapter');
const observability = require('../../index');

const adapter = createAdapter(newrelicAgent);
observability.init(adapter);

module.exports = { activated: true, providerId: 'newrelic' };
