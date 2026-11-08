/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Which requests are served by a per-user OAuth issuer (`oauth:perUserIssuer`,
 * read by the oauth2 component, which asks this only when it is on).
 *
 * A request is, when its client-facing host (`Host`, or `X-Forwarded-Host`
 * from a trusted proxy, as for DPoP) is an account's own host as the adapter
 * ingress reads it (`addressedLabelOf`: exactly one label of username shape
 * under `dns.domain`, not a name the platform answers itself), with no
 * explicit port (the account host is on 443), and the platform's name-to-core
 * row for that label names THIS core. The issuer is then
 * `https://<label>.<dns.domain>`. Everything else keeps the configured issuer:
 * a name no core serves (an issuer is a claim this core signs, unlike a
 * forwarded adapter path), a name another core serves (hostWrongCore.ts
 * answers those on /token and /authorize; discovery names the configured
 * issuer), a lookup failure.
 *
 * An address alias resolves like a username (its own name-to-core row), so
 * its host is an issuer of its own: an app started at the alias's address
 * knows the account by the alias only. Which account may consent there is the
 * consent's check (oauth2 audienceAccount.ts `issuerAccountRefusal`).
 *
 * Read per request from the live configuration (DNS topology, `dns.domain`):
 * one PlatformDB read per request on an account host, none elsewhere.
 */

import type { PerUserIssuer, PerUserIssuerOf } from 'oauth2/src/perUserIssuer.ts';
import { externalRequestHost } from 'oauth2/src/externalUri.ts';
import type { UriSource } from 'oauth2/src/externalUri.ts';
import { getPlatform } from 'platform';
import { addressedLabelOf, perUserAddressingFor } from '../../addressedAccount.ts';

type ConfigReader = { get: (key: string) => unknown };
type LoggerLike = { warn: (msg: string) => void };

/** The platform slice the lookup needs (injected by tests). */
export type IssuerPlatform = { coreId: string; getUserCore: (name: string) => Promise<string | null> };

export function perUserIssuerResolver (config: ConfigReader, logger: LoggerLike, deps: { platform?: IssuerPlatform } = {}): PerUserIssuerOf {
  return async function perUserIssuerOf (req: unknown): Promise<PerUserIssuer | null> {
    const addressing = perUserAddressingFor(config);
    if (addressing == null) return null;
    const host = externalRequestHost(req as UriSource);
    // An explicit port is no account host (anything else that is not a DNS
    // name, an IPv6 literal included, is refused by `addressedLabelOf`).
    if (host == null || host.includes(':')) return null;
    const label = addressedLabelOf(host, addressing.isPlatformRoutedLabel, addressing.domain);
    if (label == null) return null;
    const platform: IssuerPlatform = deps.platform ?? await getPlatform();
    let coreId: string | null;
    try {
      coreId = await platform.getUserCore(label);
    } catch (err: unknown) {
      logger.warn('oauth2: placement lookup failed on a per-user host, the configured issuer answers: ' +
        ((err as Error)?.message ?? String(err)));
      return null;
    }
    if (coreId == null || coreId !== platform.coreId) return null;
    return { issuer: 'https://' + label + '.' + addressing.domain, label };
  };
}
