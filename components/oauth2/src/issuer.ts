/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — issuer derivation.
 *
 * `service:api` is a per-user endpoint TEMPLATE, not a base URL:
 *   - dnsLess:    `https://host/{username}/`   (placeholder in the path)
 *   - multi-core: `https://{username}.domain/` (placeholder in the host)
 *
 * The OAuth issuer (RFC 8414 `issuer`, the `iss` parameter, and the
 * `pryvApi` value handed to the consent UI) must be a concrete URL the
 * user-agent can call `/oauth2/*` and `/reg/service/info` on. Derive it:
 *   - dnsLess: strip the trailing `/{username}/` path segment.
 *   - multi-core: the template's host is unusable — fall back to the
 *     core's own URL (`core:url`; requests land on a specific core and
 *     `/oauth2/token` forwards cross-core).
 */

/**
 * Concrete issuer URL (no trailing slash), or '' when not derivable
 * (missing `service:api`, or host-placeholder shape without `core:url`).
 */
export function issuerFromConfig (config: { get (key: string): unknown }): string {
  let api = String(config.get('service:api') ?? '');
  if (!api) return '';
  if (api.includes('{username}')) {
    if (/\/\{username\}\/?$/.test(api)) {
      api = api.replace(/\/\{username\}\/?$/, '');
    } else {
      api = String(config.get('core:url') ?? '');
    }
  }
  return api.replace(/\/$/, '');
}
