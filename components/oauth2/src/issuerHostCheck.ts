/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: the `oauth.issuer` host check, shared by the boot warning
 * (bin/master.js) and bin/check-config.js.
 *
 * On a platform with the embedded DNS (`dns.domain` set), the issuer host must
 * be a name that resolves to this core and that this core can present a
 * certificate for. A core that terminates TLS itself serves the `*.<domain>`
 * certificate only (one key pair, no SNI), so an issuer outside the domain
 * needs a proxy holding that host's certificate. Under the domain, the name
 * resolves only as this core's id, a `dns.staticEntries` key or a runtime DNS
 * record (which this check, with no database, cannot see: a warning). A label
 * the core routes elsewhere (the register host, a hosted site) can never be
 * the issuer. Without `dns.domain` the issuer host is a proxy matter and
 * nothing is reported here.
 */

import { hostedSiteNames } from 'business/src/hostedSites.ts';
import { configuredDomain, describeIssuerHost } from './issuerHost.ts';

type ConfigReader = { get (key: string): unknown };

/** Labels the core answers itself on a DNS-topology host, before any OAuth route. */
const SERVICE_LABELS: Record<string, string> = {
  reg: 'the register host (requests on it are mapped to /reg/*)',
  access: 'the register host (requests on it are mapped to /reg/*)',
  mfa: 'the register host (requests on it are mapped to /reg/*)',
  lsc: 'the embedded DNS (cluster discovery)'
};

export type IssuerHostReport = { problems: string[]; warnings: string[] };

/** Whether this core serves HTTPS itself (its own key pair, or one Let's Encrypt fetches). */
function terminatesTls (config: ConfigReader): boolean {
  const keyFile = config.get('http:ssl:keyFile');
  return config.get('letsEncrypt:enabled') === true || (typeof keyFile === 'string' && keyFile.trim() !== '');
}

/**
 * Problems (the issuer can never work) and warnings (it works only with
 * something this configuration does not show) about the `oauth.issuer` host.
 */
export function issuerHostReport (config: ConfigReader): IssuerHostReport {
  const report: IssuerHostReport = { problems: [], warnings: [] };
  const raw = config.get('oauth:issuer');
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return report;
  const issuer = describeIssuerHost(config);
  if (issuer == null) {
    report.problems.push(`oauth.issuer (${JSON.stringify(raw)}) is not an absolute http(s) URL: ` +
      'it is published as is in the discovery document and in the tokens, so no client can use it. ' +
      'Set it to the public base URL of this core\'s OAuth endpoints, e.g. https://auth.example.com.');
    return report;
  }
  const domain = configuredDomain(config);
  if (domain == null) return report;
  const { host, underDomain, label } = issuer;

  if (!underDomain) {
    if (terminatesTls(config)) {
      report.warnings.push(`oauth.issuer names ${host}, outside dns.domain (${domain}), while this core terminates TLS ` +
        `itself with a certificate for *.${domain} only: browsers and clients get a certificate for the wrong name on ` +
        `the issuer host. Put the issuer under dns.domain (for example https://auth.${domain}, with a dns.staticEntries ` +
        `entry for auth on every core running the embedded DNS), or terminate TLS for ${host} in a proxy in front of the core.`);
    }
    return report;
  }
  if (label == null) return report;

  const routedBy = SERVICE_LABELS[label] ??
    (hostedSiteNames(config).includes(label) ? `the hosted site ${label} (answered before the API)` : null);
  if (routedBy != null) {
    report.problems.push(`oauth.issuer names ${host}, whose label ${label} is served by ${routedBy} and cannot be ` +
      'the OAuth issuer; pick another name.');
    return report;
  }

  const coreId = String(config.get('core:id') || 'single').toLowerCase();
  const staticEntries = config.get('dns:staticEntries');
  const staticNames = staticEntries != null && typeof staticEntries === 'object'
    ? Object.keys(staticEntries).map((n) => n.toLowerCase())
    : [];
  if (label !== coreId && !staticNames.includes(label)) {
    report.warnings.push(`oauth.issuer names ${host} under dns.domain, but nothing in this configuration makes that ` +
      `name resolve: it is neither this core's id nor a dns.staticEntries key. Add dns.staticEntries.${label} (pointing ` +
      'at this core, on every core running the embedded DNS) or a runtime DNS record (bin/dns-records.js), else the ' +
      'issuer host answers NXDOMAIN.');
  }
  return report;
}

/** Every message of the report, for the boot log (the boot never refuses on these). */
export function issuerHostWarnings (config: ConfigReader): string[] {
  const { problems, warnings } = issuerHostReport(config);
  return problems.concat(warnings);
}
