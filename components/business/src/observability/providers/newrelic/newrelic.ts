/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * New Relic agent config.
 *
 * The `newrelic` package auto-discovers this file via `NEW_RELIC_HOME`
 * (set by master) on `require('newrelic')`. Every field reads from env
 * so the master process can shape agent behaviour without on-disk
 * config edits per deployment.
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

export const config = {
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
      'request.headers.referer'
      // Deliberately retained: user-agent, accept, content-type,
      // content-length. Operationally useful and not subject-linking.
    ]
  },
  // Attribute exclusion cannot reach SEGMENT and SPAN NAMES, which embed the
  // outbound path on cross-core forwards. Obfuscation is the only mechanism
  // that rewrites those. Masks the leading path segment (the username),
  // cuid-shaped ids, and any trailing query text, while leaving the route
  // words in between: /wactiv/events/c123... becomes */events/*
  // Hard-coded rather than env-gated so it can be cited as a constant.
  url_obfuscation: {
    enabled: true,
    regex: {
      pattern: '(^/[^/?]+)|(c[a-z0-9]{20,})|(\\?.*$)',
      flags: 'g',
      replacement: '*'
    }
  },
  application_logging: {
    enabled: true,
    forwarding: {
      // The agent auto-instruments winston and forwards log RECORDS including
      // message bodies. Attribute exclusion does not apply to a log message,
      // and nothing in this stack scrubs identifiers out of one (the logger's
      // redaction covers credential-shaped values only). So this ships OFF:
      // an operator who wants log forwarding turns it on knowingly and owns
      // what the messages contain. Read from env here rather than relying on
      // the agent's env-over-file precedence, so the default is deterministic
      // and testable.
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
