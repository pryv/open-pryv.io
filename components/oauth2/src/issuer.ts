/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — issuer derivation.
 *
 * The OAuth issuer (RFC 8414 `issuer`, the `iss` parameter, and the
 * `pryvApi` value handed to the consent UI) must be a concrete URL the
 * user-agent can call `/oauth2/*` and `/reg/service/info` on.
 *
 * Derived TOPOLOGY-FIRST, from the deployment's authoritative public
 * base URL, in precedence order:
 *
 *   1. `oauth:issuer` — explicit operator override. The escape hatch for
 *      deployments where the public issuer URL differs from the internally
 *      configured service URLs (reverse proxy, custom domain, TLS
 *      terminator). Authoritative when set.
 *   2. `dnsLess:publicUrl` — the single concrete base URL of a dnsLess
 *      deployment (username lives in the path). Read directly, NOT gated on
 *      the `dnsLess:isActive` flag: only dnsLess-style deployments set
 *      `publicUrl` (multi-core leaves it unset and resolves via step 3),
 *      while `isActive`'s resolved value is scope-priority- and timing-
 *      dependent at route-mount time (default-config sets it true,
 *      test-config false, initCore re-injects true) — keying on it mounts
 *      the OAuth surface inconsistently across app instances.
 *   3. `service:api` per-user TEMPLATE, reverse-engineered — back-compat
 *      fallback. `service:api` is not a base URL:
 *        - dnsLess:    `https://host/{username}/`   (placeholder in path)
 *        - multi-core: `https://{username}.domain/` (placeholder in host)
 *      dnsLess shape → strip the trailing `/{username}/`; multi-core shape
 *      → the template host is unusable, fall back to this core's own
 *      `core:url` (requests land on a specific core; `/oauth2/token`
 *      forwards cross-core).
 *
 * Deriving from the topology base URL (1–2) rather than the per-user
 * template (3) is robust to a `service:api` that is inconsistent with the
 * runtime topology (e.g. a multi-core service-info template loaded into a
 * dnsLess-configured core).
 */

/**
 * Concrete issuer URL (no trailing slash), or '' when not derivable
 * (no override, not dnsLess-with-publicUrl, and missing `service:api` or
 * host-placeholder shape without `core:url`).
 */
export function issuerFromConfig (config: { get (key: string): unknown }): string {
  // 1. Explicit operator override.
  const explicit = String(config.get('oauth:issuer') ?? '');
  if (explicit) return explicit.replace(/\/$/, '');

  // 2. dnsLess deployment: the public base URL is the issuer. Presence of
  //    publicUrl is the signal (only dnsLess/dev/test set it); not gated on
  //    dnsLess:isActive, whose value is timing-dependent at mount.
  const publicUrl = String(config.get('dnsLess:publicUrl') ?? '');
  if (publicUrl) return publicUrl.replace(/\/$/, '');

  // 3. Reverse-engineer the `service:api` per-user template.
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

/**
 * The audience values a `private_key_jwt` client assertion (RFC 7523)
 * may name: the issuer URL OR the token-endpoint URL. BOTH are derived
 * SERVER-SIDE from config exactly as the discovery document derives them
 * (`issuerFromConfig` + the `/oauth2/token` path) — never from request
 * headers — so the token endpoint's trust posture is unchanged (no
 * header is consulted to decide who the assertion was addressed to).
 * Returns [] when the issuer is not derivable (fail-closed: aud cannot
 * be satisfied, so the assertion is refused).
 */
export function tokenEndpointAudiences (config: { get (key: string): unknown }): string[] {
  const issuer = issuerFromConfig(config);
  if (!issuer) return [];
  return [issuer, issuer + '/oauth2/token'];
}
