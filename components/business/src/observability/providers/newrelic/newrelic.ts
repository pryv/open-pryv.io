/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * New Relic agent config.
 *
 * The `newrelic` package auto-discovers this file via `NEW_RELIC_HOME`
 * (set by master) on `require('newrelic')`. Every field reads from env
 * so the master process can shape agent behaviour without on-disk
 * config edits per deployment.
 *
 * Defaults: error-only logs, HSM off (must match account-side exactly
 * or connect returns 409), request-body + auth/cookie/x-* headers
 * excluded from transaction attributes.
 */

'use strict';

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'open-pryv.io'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  // HSM is account-side, irreversible once enabled. Default OFF so the
  // agent can connect to any account; operators who opt into account-
  // side HSM flip NEW_RELIC_HIGH_SECURITY=true in env. The attribute
  // exclude list below still protects sensitive headers and bodies.
  high_security: String(process.env.NEW_RELIC_HIGH_SECURITY || 'false') === 'true',
  process_host: {
    display_name: process.env.NEW_RELIC_PROCESS_HOST_DISPLAY_NAME || ''
  },
  logging: {
    level: process.env.NEW_RELIC_LOG_LEVEL || 'error',
    filepath: process.env.NEW_RELIC_LOG || 'stdout'
  },
  allow_all_headers: false,
  attributes: {
    exclude: [
      'request.headers.authorization',
      'request.headers.cookie',
      'request.headers.proxy-authorization',
      'request.headers.set-cookie*',
      'request.headers.x-*',
      'request.body'
    ]
  },
  distributed_tracing: { enabled: true },
  transaction_tracer: {
    enabled: true,
    record_sql: 'off' // redundant with high_security but explicit
  }
};
