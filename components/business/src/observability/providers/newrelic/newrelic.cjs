/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * New Relic agent config.
 *
 * ⚠ THE FILENAME AND EXTENSION ARE LOAD-BEARING. The agent discovers this
 * file by scanning NEW_RELIC_HOME (set by master) for one of exactly
 * `newrelic.js`, `newrelic.cjs`, `newrelic.mjs`, or whatever
 * NEW_RELIC_CONFIG_FILENAME names. Nothing requires this module explicitly:
 * `require('newrelic')` finds it, or silently falls back to environment
 * variables and built-in defaults. A previous version of this config lived in
 * a `.ts` file, which the agent cannot discover, so none of the protection
 * below was ever applied at runtime: the vendor received request URLs, the
 * Host header, route parameters and forwarded log messages regardless of what
 * the file said. `.cjs` (not `.js`) because this package is ESM and the agent
 * loads the file with require().
 *
 * Keep the config in THIS file. `newrelic.ts` re-exports it so callers and
 * tests have one source of truth.
 *
 * Defaults, in one place because this is the authoritative answer to "what
 * does our APM vendor receive?":
 * - error-only agent diagnostics;
 * - High Security Mode OFF (it is account-side and irreversible, and a
 *   client/account mismatch makes the agent refuse to connect); the
 *   protection below does not depend on it;
 * - excluded from every destination: request bodies, auth/cookie/x-*
 *   headers, request URLs (`request.uri`, `http.url`), route and query
 *   parameters (`request.parameters.*`, which is how a username or a
 *   credential passed in a query string would otherwise travel), and the
 *   Host/Referer headers (Host carries the username as a subdomain in
 *   DNS-ful topologies);
 * - URL obfuscation ON, because segment and span NAMES embed outbound
 *   paths and attribute exclusion cannot reach a name;
 * - SQL capture off;
 * - application log forwarding OFF: the agent would otherwise forward
 *   winston records including message bodies, which nothing in this stack
 *   scrubs for identifiers.
 * What still flows: route-shaped transaction names, status codes, timings,
 * this core's FQDN, and datastore/external call timing.
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
      'request.body',
      // Subject-linking attributes. A request path on this API carries the
      // username, event ids and attachment ids; the Host header carries the
      // username as a subdomain in DNS-ful topologies; and the agent captures
      // route parameters (request.parameters.route.username) plus outbound
      // query parameters, which is how a credential passed as ?auth= or
      // ?readToken= would reach the vendor on a cross-core forward.
      // The APM signal worth keeping is route SHAPE, status and timing, all of
      // which survive these exclusions.
      'request.uri',
      'request.parameters.*',
      'http.url',
      'request.headers.host',
      'request.headers.referer',
      // Privacy over debuggability: a User-Agent is a fingerprinting
      // contributor even though it identifies nobody on its own.
      'request.headers.user-agent'
      // Retained: accept, content-type, content-length. These describe the
      // shape of a request, not who made it.
    ]
  },
  // Attribute exclusion cannot reach SEGMENT and SPAN NAMES, which embed the
  // outbound path on cross-core forwards and on webhook deliveries.
  // Obfuscation is the only mechanism that rewrites those.
  //
  // This masks the ENTIRE path rather than matching identifier shapes.
  // Shape-matching was tried and leaked: it caught leading segments and
  // cuid-shaped ids, but attachment filenames, user-chosen stream ids, and
  // anything in a non-leading segment survived (an attachment download
  // forwarded between cores became `*/events/*/*/blood-report-jane-doe.pdf`).
  // Enumerating every identifier shape a caller might use is a losing game,
  // so nothing in a path is treated as safe. The cost is the loss of
  // per-route latency breakdown on EXTERNAL calls; transaction names remain
  // route-shaped, so the APM view of our own routes is unaffected.
  // Hard-coded rather than env-gated so it can be cited as a constant.
  url_obfuscation: {
    enabled: true,
    regex: {
      pattern: '^/.*',
      flags: '',
      replacement: '*'
    }
  },
  // Redact the messages of captured errors. Our own validation errors quote
  // client-supplied values (rejected stream ids, for instance), and an
  // extension can put anything in a message, so message text is not a
  // surface we can keep clean by review.
  strip_exception_messages: { enabled: true },
  // Nothing in production emits these, and they are an easy accidental
  // channel for identifiers, so they are shut rather than left available.
  custom_insights_events: { enabled: false },
  api: { custom_attributes_enabled: false },
  application_logging: {
    enabled: true,
    forwarding: {
      // The agent auto-instruments winston and forwards log RECORDS including
      // message bodies. Attribute exclusion does not apply to a log message,
      // and nothing in this stack scrubs identifiers out of one. So this ships
      // OFF: an operator who wants log forwarding turns it on knowingly and
      // owns what the messages contain. Read from env here rather than relying
      // on the agent's env-over-file precedence, so the default is
      // deterministic and testable.
      enabled: String(process.env.NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED || 'false') === 'true'
    },
    // Log-to-metric counts carry no message content.
    metrics: { enabled: true },
    // Would inject trace identifiers into local log lines; no vendor egress,
    // but no value either while forwarding is off.
    local_decorating: { enabled: false }
  },
  distributed_tracing: { enabled: true },
  transaction_tracer: {
    enabled: true,
    record_sql: 'off' // redundant with high_security but explicit
  }
};
