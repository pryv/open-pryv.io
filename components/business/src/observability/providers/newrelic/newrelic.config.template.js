/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 38 — New Relic agent config template.
 *
 * The `newrelic` package looks for this file on `require('newrelic')`.
 * Every field reads from env so the master process can shape agent
 * behaviour without on-disk config edits.
 *
 * Defaults enforce high_security + error-only logs. Operators raise
 * verbosity through PlatformDB (`observability-log-level`), which
 * master translates into NEW_RELIC_LOG_LEVEL before forking workers.
 */

'use strict';

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'open-pryv.io'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  high_security: String(process.env.NEW_RELIC_HIGH_SECURITY || 'true') === 'true',
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
