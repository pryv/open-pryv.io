/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Default administration portal of this core release.
 *
 * The portal is a static build published on GitHub Pages; a core exposes it on a
 * reserved platform name with a `hostedSites` entry (`proxy:` to the Pages build, or
 * `static:` to an unpacked release for custom or air-gapped installs). The install
 * wizard (`bin/init.js`) writes that entry from these values on new installs.
 *
 * Each published portal version is an immutable directory `<base><version>/` holding
 * two builds: `root/` (served at `/`, DNS topology: `<site>.<dns.domain>`) and
 * `prefixed/` (served under `/admin/`, dnsLess: `<publicUrl>/admin/`).
 *
 * Release checklist: bump `PORTAL_VERSION` to the portal version published for this
 * core release (it must exist on Pages before the core is tagged), and
 * `PORTAL_CONTRACT` when the core's portal contract changes.
 */

/** Pages base of the published portal builds (ends with `/`). */
const PORTAL_PAGES_BASE = 'https://pryv.github.io/app-web-platform-portal/';
/** Portal version matching this core release. */
const PORTAL_VERSION = '0.1.0';
/** Portal contract this core implements (an integer, bumped on a non-additive change). */
const PORTAL_CONTRACT = 1;
/** Default hosted site name of the portal; the published `prefixed/` build assumes it. */
const PORTAL_DEFAULT_SITE = 'admin';

/** Pages URL of the portal build matching this core release, for the given topology. */
function portalPagesUrl (opts: { dnsLess: boolean; version?: string }): string {
  const version = opts.version ?? PORTAL_VERSION;
  return `${PORTAL_PAGES_BASE}${version}/${opts.dnsLess ? 'prefixed' : 'root'}/`;
}

/**
 * Content-Security-Policy the core adds on the portal site, on top of the upstream's
 * own: scripts and assets from the site itself only, API calls to this platform only.
 * dnsLess: the API is on the portal's own origin. DNS topology: the API is on the
 * platform's hosts (`https://*.<dns.domain>`).
 */
function portalSiteCsp (opts: { dnsLess: boolean; dnsDomain?: string | null }): string {
  const connect = opts.dnsLess || !opts.dnsDomain
    ? "connect-src 'self'"
    : `connect-src 'self' https://*.${opts.dnsDomain}`;
  return `default-src 'self'; ${connect}; object-src 'none'; base-uri 'self'; form-action 'self'`;
}

/** Address of the portal once exposed on `site`, for the given topology. */
function portalUrl (opts: { site: string; dnsLess: boolean; publicUrl?: string | null; dnsDomain?: string | null }): string {
  if (opts.dnsLess) return `${(opts.publicUrl || '').replace(/\/+$/, '')}/${opts.site}/`;
  return `https://${opts.site}.${opts.dnsDomain}/`;
}

export { PORTAL_PAGES_BASE, PORTAL_VERSION, PORTAL_CONTRACT, PORTAL_DEFAULT_SITE, portalPagesUrl, portalSiteCsp, portalUrl };
