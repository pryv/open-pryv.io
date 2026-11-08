/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: the issuer of a request on an account's own host (`oauth:perUserIssuer`).
 *
 * Off (the default), the issuer is the configured one (issuer.ts) on every
 * host. On, a request that reaches this core on an account's own host
 * (`https://<name>.<dns.domain>`, the account served by this core) is served
 * by the issuer `https://<name>.<dns.domain>`: the discovery documents, the
 * authorization (its `iss`, the consent hand-off `pryvApi`), the code and
 * refresh rows and the id_token name it, and a code or refresh token is
 * redeemed only at the issuer that issued it (RFC 9207 mix-up defence).
 * Introspection, revocation and the token exchange keep the configured issuer
 * in what they answer (resource servers call them at a fixed host); a client
 * assertion names the issuer of the host it is presented at, at every
 * endpoint (`/oauth2/token`, `/oauth2/revoke`, `/oauth2/introspect`).
 *
 * Which host names an account is the host application's knowledge (the
 * platform's own names, where each account is served): it is injected as a
 * `PerUserIssuerOf`. This module reads the switch and combines the two.
 * Platform-wide (every core answers the same rule), DNS topology only: on a
 * dnsLess core there is no account host, and the setting is refused at boot.
 */

import { issuerFromConfig } from './issuer.ts';

type ConfigReader = { get (key: string): unknown };

/** The issuer of a request on an account's host: `https://<label>.<dns.domain>`, and that label. */
export type PerUserIssuer = { issuer: string; label: string };

/** The per-user issuer of a request, or null for any host that is not an account's host on this core. */
export type PerUserIssuerOf = (req: unknown) => Promise<PerUserIssuer | null>;

/** The issuer a request is served by, and its per-user part (null: the configured issuer). */
export type RequestIssuer = { issuer: string; perUser: PerUserIssuer | null };

/** The setting as a boolean, or null when it is neither a boolean nor `true` / `false`. */
export function parsePerUserIssuer (value: unknown): boolean | null {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return null;
}

/** Whether `oauth:perUserIssuer` is on. */
export function perUserIssuerOn (config: ConfigReader): boolean {
  return parsePerUserIssuer(config.get('oauth:perUserIssuer')) === true;
}

/**
 * The configuration problems of the setting (the boot refuses each): a value
 * that is not a boolean, the switch on a dnsLess core (no account host
 * exists there) or without `dns.domain` (account hosts are `<name>.<dns.domain>`).
 * An operator who turns it on expects an effect: refused rather than ignored.
 */
export function perUserIssuerProblems (config: ConfigReader): string[] {
  const value = config.get('oauth:perUserIssuer');
  const on = parsePerUserIssuer(value);
  if (on == null) {
    return [`oauth.perUserIssuer is ${JSON.stringify(value)}: true or false is expected (it decides whether an account's ` +
      'own host is its OAuth issuer).'];
  }
  if (!on) return [];
  if (config.get('dnsLess:isActive') !== false) {
    return ['oauth.perUserIssuer is true on a dnsLess core (dnsLess.isActive is not false): a dnsLess core has no ' +
      'per-account host, so no request could be served by a per-user issuer. Turn it off, or run the DNS topology.'];
  }
  const domain = config.get('dns:domain');
  if (typeof domain !== 'string' || domain.trim() === '') {
    return ['oauth.perUserIssuer is true but dns.domain is not set: a per-user issuer is https://<name>.<dns.domain>. ' +
      'Set dns.domain, or turn it off.'];
  }
  return [];
}

/**
 * The issuer serving `req`: the per-user one when the switch is on and the
 * host application names one for the request, else the configured one ('' when
 * none is derivable, as `issuerFromConfig`).
 */
export async function requestIssuer (config: ConfigReader, perUserIssuerOf: PerUserIssuerOf | null | undefined, req: unknown): Promise<RequestIssuer> {
  const configured = issuerFromConfig(config);
  if (!configured || perUserIssuerOf == null || !perUserIssuerOn(config)) return { issuer: configured, perUser: null };
  const perUser = await perUserIssuerOf(req);
  return perUser == null ? { issuer: configured, perUser: null } : { issuer: perUser.issuer, perUser };
}

/** The `reason` of a consent step that reached another issuer than the authorization's. */
export const ISSUER_MISMATCH = 'issuer-mismatch';

/**
 * A consent step (`/offer`, `/accept`, `/refuse`) must reach the issuer the
 * authorization was made at (the state's, or the configured one for a state
 * that names none): null when it does, else the 400 answer.
 */
export function stateIssuerRefusal (config: ConfigReader, stateIssuer: string | undefined, current: RequestIssuer):
{ status: number; body: { error: string; error_description: string; reason: string } } | null {
  if ((stateIssuer ?? issuerFromConfig(config)) === current.issuer) return null;
  return {
    status: 400,
    body: {
      error: 'invalid_request',
      error_description: 'the authorization was started at another address: restart the authorization flow',
      reason: ISSUER_MISMATCH,
    },
  };
}

/** The host (lowercased, no final dot, port kept) of an absolute URL, or null. */
export function urlHost (value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const name = u.hostname.toLowerCase().replace(/\.$/, '');
  return u.port !== '' ? name + ':' + u.port : name;
}
