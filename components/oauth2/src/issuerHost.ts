/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: where the configured issuer host sits relative to `dns.domain`.
 *
 * On a platform with the embedded DNS, an issuer host `<label>.<dns.domain>`
 * is a name the platform answers (a static entry or a runtime record pointing
 * at this core), so its label must never become a username: registration
 * refuses it (Platform.refreshPlatformNames) and check-config judges the
 * topology (issuerHostCheck.ts). Only the explicit `oauth.issuer` counts: a
 * derived issuer is the core's own host, already reserved as a core id.
 * Pure: no I/O, no dependency, so the platform and the CLI checks share it.
 */

type ConfigReader = { get (key: string): unknown };

export type IssuerHost = {
  /** Lowercased host name of `oauth.issuer` (no port). */
  host: string;
  /** Whether the host is `dns.domain` itself or a name under it. */
  underDomain: boolean;
  /**
   * The single label before `.<dns.domain>` (`auth-eu` for `auth-eu.<domain>`),
   * null for the domain itself, a deeper name or a host outside the domain.
   */
  label: string | null;
};

/** `dns.domain` lowercased without a trailing dot, or null when unset. */
export function configuredDomain (config: ConfigReader): string | null {
  const domain = config.get('dns:domain');
  if (typeof domain !== 'string' || domain.trim() === '') return null;
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * The host of `oauth.issuer` relative to `dns.domain`, or null when
 * `oauth.issuer` is unset or not an absolute http(s) URL. Without
 * `dns.domain`, `underDomain` is false and `label` null.
 */
export function describeIssuerHost (config: ConfigReader): IssuerHost | null {
  const raw = config.get('oauth:issuer');
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return null;
  const domain = configuredDomain(config);
  if (domain == null) return { host, underDomain: false, label: null };
  if (host === domain) return { host, underDomain: true, label: null };
  if (!host.endsWith('.' + domain)) return { host, underDomain: false, label: null };
  const prefix = host.slice(0, -(domain.length + 1));
  return { host, underDomain: true, label: prefix.includes('.') ? null : prefix };
}

/** The first label of the configured issuer host when it is `<label>.<dns.domain>`, else null. */
export function issuerLabelUnderDomain (config: ConfigReader): string | null {
  return describeIssuerHost(config)?.label ?? null;
}
