/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Third-party sign-in — provider registry + discovery cache.
 *
 * Reads the operator's `sso:providers` allow-list into a typed registry and
 * lazily builds (and caches, per provider) an openid-client `Configuration`
 * from the IdP's discovery document. Discovery is a network fetch, so it is
 * memoised for `DISCOVERY_TTL_MS` (rotating keys are still picked up within the
 * window because openid-client re-fetches the JWKS on demand during token
 * validation).
 *
 * `allowInsecureRequests` is enabled ONLY for an `http:` issuer — which the
 * boot validator (`checkSsoConfig`) forbids in real config, so it is reachable
 * only from tests pointing at the in-process fake IdP on `127.0.0.1`.
 */

import * as oidc from 'openid-client';
import type { ConfigLike } from '@pryv/boiler';

/** One entry of the operator allow-list, normalized. */
export type ProviderDef = {
  id: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
};

/** Public descriptor (id + label only) — safe to serve to a sign-in page. */
export type ProviderPublic = { id: string; label: string };

/** How long a discovered Configuration is reused before re-discovery. */
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;

function asString (value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Read + normalize `sso:providers` into a Map keyed by provider id. */
export function readProviders (config: ConfigLike): Map<string, ProviderDef> {
  const raw = config.get('sso:providers');
  const out = new Map<string, ProviderDef>();
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    out.set(id, {
      id,
      issuer: asString(v.issuer),
      clientId: asString(v.clientId),
      clientSecret: asString(v.clientSecret),
      label: asString(v.label, id)
    });
  }
  return out;
}

/** A provider registry: the allow-list + a lazily-populated discovery cache. */
export type Registry = {
  providers: Map<string, ProviderDef>;
  getConfiguration: (providerId: string) => Promise<oidc.Configuration | null>;
  listPublic: () => ProviderPublic[];
};

type CacheEntry = { config: oidc.Configuration; expiresAt: number };

/**
 * Build a registry over the current config. `nowMs` is injectable so the TTL
 * is testable without wall-clock waits.
 */
export function createRegistry (config: ConfigLike, nowMs: () => number = () => Date.now()): Registry {
  const providers = readProviders(config);
  const cache = new Map<string, CacheEntry>();

  async function getConfiguration (providerId: string): Promise<oidc.Configuration | null> {
    const def = providers.get(providerId);
    if (def == null || def.issuer === '') return null;
    const cached = cache.get(providerId);
    if (cached != null && cached.expiresAt > nowMs()) return cached.config;

    const issuerUrl = new URL(def.issuer);
    const insecure = issuerUrl.protocol === 'http:';
    const options = insecure ? { execute: [oidc.allowInsecureRequests] } : undefined;
    const configuration = await oidc.discovery(issuerUrl, def.clientId, def.clientSecret, undefined, options);
    // Persist the insecure-transport allowance for subsequent token requests.
    if (insecure) oidc.allowInsecureRequests(configuration);
    // NOTE (security posture): the authorization-code flow receives the
    // id_token over a direct TLS + client-authenticated channel, so
    // openid-client (per OIDC Core §3.1.3.7) validates iss/aud/exp/nonce but
    // NOT the JWS signature — token authenticity rests on the TLS server-cert
    // check + the client secret. `enableNonRepudiationChecks(configuration)`
    // would add signature validation as defense-in-depth; deferred (it forces
    // a JWKS fetch per validation with retry latency). Flagged for review.

    cache.set(providerId, { config: configuration, expiresAt: nowMs() + DISCOVERY_TTL_MS });
    return configuration;
  }

  function listPublic (): ProviderPublic[] {
    return [...providers.values()].map((p) => ({ id: p.id, label: p.label }));
  }

  return { providers, getConfiguration, listPublic };
}
