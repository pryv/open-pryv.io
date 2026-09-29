/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import path from 'node:path';

/**
 * Hosted sites: a reserved platform name that serves either a static folder
 * or a fixed upstream, instead of a user account.
 *
 *   hostedSites:
 *     account:
 *       static: /srv/sites/account
 *     docs:
 *       proxy: https://example.github.io/docs/
 *       headers:
 *         content-security-policy: "default-src 'self'"
 *
 * The name set is platform-wide (every core refuses it as a username and the
 * embedded DNS answers it with the cores that advertise it); `static` paths
 * are per-core. This module is the single validator, shared by the boot-time
 * config validation, `bin/check-config.js`, the platform, the DNS server and
 * the request dispatcher. Pure: it reads the values it is given, never the
 * filesystem or the network.
 */

type StaticSite = { name: string; kind: 'static'; root: string; headers: Record<string, string> };
type ProxySite = { name: string; kind: 'proxy'; upstream: string; headers: Record<string, string> };
type HostedSite = StaticSite | ProxySite;

type HostedSitesInput = {
  /** Raw `hostedSites` value. */
  hostedSites: unknown;
  /** `dns.domain` (null when unset). */
  domain: string | null | undefined;
  /** `dnsLess.isActive`. */
  dnsLessActive: boolean;
  /** `dnsLess.publicUrl`, used for the upstream loop check in dnsLess mode. */
  publicUrl?: string | null;
  /** `core.id`. */
  coreId?: string | null;
  /** Keys of `dns.staticEntries`. */
  staticEntryNames?: string[];
};

type HostedSitesReport = { sites: Map<string, HostedSite>; problems: string[]; warnings: string[] };

/** A DNS label: 1-63 chars, lowercase letters, digits and inner hyphens. */
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAME_MAX = 63;

/** Names the distribution answers itself (see the DNS server). */
const DISTRIBUTION_NAMES = ['reg', 'access', 'mfa', 'lsc'];

/**
 * In dnsLess mode a site lives at `/<name>/` on the one public host, so its
 * name must not be the first segment of an API route served there.
 */
const DNSLESS_ROUTE_SEGMENTS = ['reg', 'system', 'www', 'auth', 'users', 'oauth2', 'service', 'apps'];

/** Operator headers that would break the response framing or set state. */
const FORBIDDEN_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'content-length', 'host'
]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function hostOf (url: string | null | undefined): string | null {
  if (url == null || url === '') return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Validate the `hostedSites` block. Never throws: returns the valid sites and
 * the list of problems (each naming its key path) and warnings.
 */
function describeHostedSites (input: HostedSitesInput): HostedSitesReport {
  const sites = new Map<string, HostedSite>();
  const problems: string[] = [];
  const warnings: string[] = [];
  const raw = input.hostedSites;
  if (raw == null) return { sites, problems, warnings };
  if (!isPlainObject(raw)) {
    problems.push('hostedSites must be a map of name -> { static | proxy }');
    return { sites, problems, warnings };
  }
  const names = Object.keys(raw);
  if (names.length === 0) return { sites, problems, warnings };

  const domain = (input.domain || '').toLowerCase() || null;
  if (!input.dnsLessActive && domain == null) {
    problems.push('hostedSites needs a hostname to answer on: set dns.domain (sites are served on <name>.<dns.domain>) or use dnsLess (sites are served under /<name>/)');
  }
  const coreId = input.coreId ? String(input.coreId).toLowerCase() : null;
  const staticEntryNames = new Set((input.staticEntryNames || []).map((n) => n.toLowerCase()));
  const loopHosts = new Set<string>();
  const publicHost = hostOf(input.publicUrl);
  if (input.dnsLessActive && publicHost != null) loopHosts.add(publicHost);

  for (const name of names) {
    const where = `hostedSites.${name}`;
    const siteProblems: string[] = [];
    if (name.length > NAME_MAX || !NAME_RE.test(name)) {
      siteProblems.push(`${where}: the name must be a DNS label (1-63 lowercase letters, digits or inner hyphens)`);
    } else {
      if (DISTRIBUTION_NAMES.includes(name)) {
        siteProblems.push(`${where}: "${name}" is answered by the distribution itself; pick another name`);
      }
      if (coreId != null && name === coreId) {
        siteProblems.push(`${where}: "${name}" is this core's id (core.id); pick another name`);
      }
      if (staticEntryNames.has(name)) {
        siteProblems.push(`${where}: "${name}" is also a dns.staticEntries key; remove one of the two`);
      }
      if (input.dnsLessActive && DNSLESS_ROUTE_SEGMENTS.includes(name)) {
        siteProblems.push(`${where}: in dnsLess mode the site is served under /${name}/, which is an API route; pick another name`);
      }
    }
    const entry = raw[name];
    if (!isPlainObject(entry)) {
      problems.push(...siteProblems, `${where} must be an object with either "static" or "proxy"`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!['static', 'proxy', 'headers'].includes(key)) {
        siteProblems.push(`${where}.${key}: unknown key (expected static, proxy or headers)`);
      }
    }
    const hasStatic = entry.static != null && entry.static !== '';
    const hasProxy = entry.proxy != null && entry.proxy !== '';
    if (hasStatic === hasProxy) {
      siteProblems.push(`${where}: set exactly one of "static" (a folder) or "proxy" (an upstream URL)`);
    }

    const headers: Record<string, string> = {};
    if (entry.headers != null) {
      if (!isPlainObject(entry.headers)) {
        siteProblems.push(`${where}.headers must be a map of header name -> string value`);
      } else {
        for (const [hName, hValue] of Object.entries(entry.headers)) {
          const lower = hName.toLowerCase();
          if (!HEADER_NAME_RE.test(lower)) {
            siteProblems.push(`${where}.headers.${hName}: not a valid header name`);
          } else if (FORBIDDEN_HEADERS.has(lower)) {
            siteProblems.push(`${where}.headers.${hName}: this header cannot be set by configuration`);
          } else if (typeof hValue !== 'string' || /[\r\n\0]/.test(hValue)) {
            siteProblems.push(`${where}.headers.${hName}: the value must be a single-line string`);
          } else {
            headers[lower] = hValue;
          }
        }
      }
    }

    let site: HostedSite | null = null;
    if (hasStatic && !hasProxy) {
      if (typeof entry.static !== 'string' || !path.isAbsolute(entry.static)) {
        siteProblems.push(`${where}.static must be an absolute folder path`);
      } else {
        site = { name, kind: 'static', root: path.resolve(entry.static), headers };
      }
    } else if (hasProxy && !hasStatic) {
      let url: URL | null = null;
      try { url = new URL(String(entry.proxy)); } catch { url = null; }
      if (typeof entry.proxy !== 'string' || url == null || !['http:', 'https:'].includes(url.protocol)) {
        siteProblems.push(`${where}.proxy must be an absolute http(s) URL`);
      } else if (url.username !== '' || url.password !== '') {
        siteProblems.push(`${where}.proxy must not carry credentials`);
      } else if (url.search !== '' || url.hash !== '') {
        siteProblems.push(`${where}.proxy must not carry a query or a fragment (the request path and query are appended to it)`);
      } else {
        const host = url.hostname.toLowerCase();
        if ((domain != null && (host === domain || host.endsWith('.' + domain))) || loopHosts.has(host)) {
          siteProblems.push(`${where}.proxy points at this platform (${host}); the request would loop back here`);
        } else {
          if (!url.pathname.endsWith('/')) url.pathname += '/';
          if (url.protocol === 'http:') {
            warnings.push(`${where}.proxy uses http: the content travels in clear between this core and ${host}`);
          }
          site = { name, kind: 'proxy', upstream: url.toString(), headers };
        }
      }
    }
    if (siteProblems.length > 0) {
      problems.push(...siteProblems);
      continue;
    }
    if (site != null) sites.set(name, site);
  }
  return { sites, problems, warnings };
}

type ConfigReader = { get: (key: string) => unknown };

/** Build the validator input from a boiler config. */
function hostedSitesInputFromConfig (config: ConfigReader): HostedSitesInput {
  const staticEntries = config.get('dns:staticEntries');
  return {
    hostedSites: config.get('hostedSites'),
    domain: (config.get('dns:domain') as string) || null,
    dnsLessActive: config.get('dnsLess:isActive') === true,
    publicUrl: (config.get('dnsLess:publicUrl') as string) || null,
    coreId: (config.get('core:id') as string) || null,
    staticEntryNames: isPlainObject(staticEntries) ? Object.keys(staticEntries) : []
  };
}

/**
 * Parse `hostedSites` from a boiler config; throws one Error listing every
 * problem. Boot paths use this once the config validation has passed.
 */
function parseHostedSites (config: ConfigReader): Map<string, HostedSite> {
  const { sites, problems } = describeHostedSites(hostedSitesInputFromConfig(config));
  if (problems.length > 0) {
    throw new Error('Invalid hostedSites configuration: ' + problems.join('; '));
  }
  return sites;
}

/**
 * The configured site names (lowercased), valid or not. Used where a name
 * must be reserved even if the rest of its entry is wrong: the reservation
 * never depends on the entry being servable.
 */
function hostedSiteNames (config: ConfigReader): string[] {
  const raw = config.get('hostedSites');
  if (!isPlainObject(raw)) return [];
  return Object.keys(raw).map((n) => n.toLowerCase());
}

export { describeHostedSites, hostedSitesInputFromConfig, parseHostedSites, hostedSiteNames, DNSLESS_ROUTE_SEGMENTS };
export type { HostedSite, StaticSite, ProxySite, HostedSitesInput, HostedSitesReport };
