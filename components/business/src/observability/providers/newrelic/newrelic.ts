/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Re-export of the New Relic agent config.
 *
 * The config itself lives in `newrelic.cjs`, and MUST stay there: the agent
 * discovers its config by scanning NEW_RELIC_HOME for `newrelic.js`,
 * `newrelic.cjs` or `newrelic.mjs`, so a `.ts` file is invisible to it. When
 * this config lived in a `.ts` file the agent silently ran on environment
 * variables and built-in defaults, which meant no attribute exclusion, SQL
 * captured as obfuscated rather than off, and application log forwarding on.
 *
 * This module exists so that callers and tests can read the same object the
 * agent reads, without duplicating it.
 */

'use strict';

const { config } = require('./newrelic.cjs');

export { config };
