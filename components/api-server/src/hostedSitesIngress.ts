/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream';
import send from 'send';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Logger } from '@pryv/boiler';
import type { HostedSite, ProxySite, StaticSite } from 'business/src/hostedSites.ts';

/**
 * In-process dispatcher for hosted sites: a reserved platform name that
 * serves a static folder or a fixed upstream instead of a user account.
 *
 * It sits in front of the HFS dispatcher and the API: site traffic never
 * crosses the API middleware (JSON parser, CORS, username rewriting, auth).
 *
 * Match rule per topology:
 *   - DNS topology (dnsLess off, dns.domain set): Host `<name>.<dns.domain>`.
 *   - dnsLess: path prefix `/<name>/` (`/<name>` answers 301 to `/<name>/`).
 *     Same origin as the API there; bundles are built with that base.
 *
 * Static sites behave like GitHub Pages: `index.html` for folders, `.html`
 * extension fallback, `404.html` (status 404) for misses, dotfiles and
 * anything resolving outside the folder answer 404. Proxy sites forward GET
 * and HEAD to a fixed upstream with allow-listed headers both ways.
 *
 * Known limitation: `/socket.io/*` on a site host is taken by Socket.IO,
 * which is attached to the same server ahead of every other listener.
 */

type Fallback = (req: IncomingMessage, res: ServerResponse) => void;

// Idle time on the upstream connection in either direction.
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

/** Request headers forwarded to a proxy upstream; nothing else is. */
const FORWARDED_REQUEST_HEADERS = [
  'accept', 'accept-encoding', 'accept-language', 'if-none-match', 'if-modified-since', 'range', 'user-agent'
];
/** Upstream response headers passed to the client; nothing else is. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-encoding', 'content-range', 'accept-ranges',
  'cache-control', 'expires', 'etag', 'last-modified', 'vary', 'location'
];

const HSTS_VALUE = 'max-age=31536000';

type Match = { site: HostedSite; subPath: string; search: string; prefix: string } | { redirect: string } | null;

function plain (res: ServerResponse, status: number, message: string, extra: OutgoingHttpHeaders = {}, head = false) {
  const body = message + '\n';
  res.writeHead(status, Object.assign({
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  }, extra));
  res.end(head ? undefined : body);
}

function buildHostedSitesIngress (opts: {
  sites: Map<string, HostedSite>;
  domain: string | null;
  dnsLess: boolean;
  logger: Logger;
  upstreamIdleTimeoutMs?: number;
}) {
  const { sites, logger } = opts;
  const domain = (opts.domain || '').toLowerCase() || null;
  const dnsLess = opts.dnsLess === true;
  const upstreamIdleTimeoutMs = opts.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;

  if (sites.size > 0 && !dnsLess && domain == null) {
    throw new Error('hostedSites needs dns.domain (Host match) or dnsLess (path prefix)');
  }
  const byHost = new Map<string, HostedSite>();
  for (const site of sites.values()) {
    if (site.kind === 'proxy') {
      const upstreamHost = new URL(site.upstream).hostname.toLowerCase();
      if (domain != null && (upstreamHost === domain || upstreamHost.endsWith('.' + domain))) {
        throw new Error(`hostedSites.${site.name}.proxy points at this platform (${upstreamHost})`);
      }
    }
    if (domain != null) byHost.set(site.name + '.' + domain, site);
  }
  // Static roots resolved once: the containment check compares real paths.
  const realRoots = new Map<string, string>();
  for (const site of sites.values()) {
    if (site.kind === 'static') {
      try { realRoots.set(site.name, fs.realpathSync(site.root)); } catch { realRoots.set(site.name, site.root); }
    }
  }

  function match (req: IncomingMessage): Match {
    if (sites.size === 0 || req.url == null) return null;
    // Origin-form only: prefixing keeps `//x/y` a path instead of a host.
    if (!req.url.startsWith('/')) return null;
    let url: URL;
    try { url = new URL('http://placeholder' + req.url); } catch { return null; }
    if (!dnsLess) {
      const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
      const site = byHost.get(host);
      if (site == null) return null;
      return { site, subPath: url.pathname, search: url.search, prefix: '/' };
    }
    const m = /^\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
    if (m == null) return null;
    const site = sites.get(m[1]);
    if (site == null) return null;
    if (m[2] == null) return { redirect: '/' + site.name + '/' + url.search };
    return { site, subPath: m[2], search: url.search, prefix: '/' + site.name + '/' };
  }

  function setSiteHeaders (req: IncomingMessage, res: ServerResponse, site: HostedSite) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    if ((req.socket as TLSSocket).encrypted) res.setHeader('strict-transport-security', HSTS_VALUE);
    for (const [name, value] of Object.entries(site.headers)) res.setHeader(name, value);
  }

  // ---------------------------------------------------------------- static

  async function notFound (req: IncomingMessage, res: ServerResponse, site: StaticSite, root: string) {
    const head = req.method === 'HEAD';
    const page = await resolveInside(root, path.join(root, '404.html'));
    if (page != null) {
      try {
        const body = await fs.promises.readFile(page);
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
        res.end(head ? undefined : body);
        return;
      } catch (err) {
        logger.debug(`[hosted-sites] ${site.name}: 404.html unreadable: ${(err as Error).message}`);
      }
    }
    plain(res, 404, 'Not Found', {}, head);
  }

  /** Real path of `candidate` if it exists and stays under `root`, else null. */
  async function resolveInside (root: string, candidate: string): Promise<string | null> {
    let real: string;
    try { real = await fs.promises.realpath(candidate); } catch { return null; }
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    return real;
  }

  async function isFile (p: string): Promise<boolean> {
    try { return (await fs.promises.stat(p)).isFile(); } catch { return false; }
  }

  async function isDirectory (p: string): Promise<boolean> {
    try { return (await fs.promises.stat(p)).isDirectory(); } catch { return false; }
  }

  async function serveStatic (req: IncomingMessage, res: ServerResponse, site: StaticSite, subPath: string, search: string, prefix: string) {
    const root = realRoots.get(site.name) as string;
    let decoded: string;
    try { decoded = decodeURIComponent(subPath); } catch { plain(res, 400, 'Bad Request', {}, req.method === 'HEAD'); return; }
    if (decoded.includes('\0')) { plain(res, 400, 'Bad Request', {}, req.method === 'HEAD'); return; }
    const segments = decoded.split('/').filter((s) => s !== '');
    // `..` and dotfiles (e.g. a `.git` folder) do not exist as far as clients know
    if (segments.some((s) => s.startsWith('.'))) { await notFound(req, res, site, root); return; }
    const candidate = path.join(root, ...segments);

    let file: string | null = null;
    if (decoded.endsWith('/')) {
      file = await resolveInside(root, path.join(candidate, 'index.html'));
    } else {
      const real = await resolveInside(root, candidate);
      if (real != null && await isDirectory(real)) {
        // a folder without its trailing slash: relative asset URLs need it
        res.writeHead(301, { location: prefix + segments.map(encodeURIComponent).join('/') + '/' + search, 'content-length': 0 });
        res.end();
        return;
      }
      if (real != null && await isFile(real)) file = real;
      if (file == null && path.extname(candidate) === '') {
        file = await resolveInside(root, candidate + '.html');
      }
    }
    if (file == null || !(await isFile(file))) { await notFound(req, res, site, root); return; }

    const relative = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/');
    const stream = send(req, '/' + relative, {
      root,
      index: false,
      extensions: false,
      dotfiles: 'ignore',
      maxAge: 0
    });
    // The operator's headers win over what send sets (e.g. cache-control)
    stream.on('headers', (out: ServerResponse) => {
      for (const [name, value] of Object.entries(site.headers)) out.setHeader(name, value);
    });
    stream.on('error', (err: Error & { status?: number; headers?: OutgoingHttpHeaders }) => {
      if (res.headersSent) { res.destroy(); return; }
      if (err.status === 403 || err.status === 404) {
        notFound(req, res, site, root).catch(() => res.destroy());
        return;
      }
      if (err.status != null && err.status < 500) {
        // e.g. 416 carries the Content-Range of the full file
        plain(res, err.status, http.STATUS_CODES[err.status] || 'Error', err.headers || {}, req.method === 'HEAD');
        return;
      }
      logger.warn(`[hosted-sites] ${site.name}: ${err.message}`);
      plain(res, 500, 'Internal Server Error', {}, req.method === 'HEAD');
    });
    stream.pipe(res);
  }

  // ----------------------------------------------------------------- proxy

  function rewriteLocation (location: string, site: ProxySite, prefix: string): string {
    const base = new URL(site.upstream);
    if (location.startsWith(site.upstream)) return prefix + location.slice(site.upstream.length);
    if (location.startsWith('/') && !location.startsWith('//') && location.startsWith(base.pathname)) {
      return prefix + location.slice(base.pathname.length);
    }
    return location;
  }

  function proxy (req: IncomingMessage, res: ServerResponse, site: ProxySite, subPath: string, search: string, prefix: string) {
    // Before any answer, so 400 / 502 / 504 carry them too
    setSiteHeaders(req, res, site);
    const base = new URL(site.upstream);
    const target = new URL(site.upstream);
    // Assigning the path cannot change the host, whatever the request holds.
    target.pathname = base.pathname + subPath.replace(/^\/+/, '');
    target.search = search;
    if (target.host !== base.host || target.protocol !== base.protocol) {
      plain(res, 400, 'Bad Request', {}, req.method === 'HEAD');
      return;
    }
    const headers: OutgoingHttpHeaders = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (value != null) headers[name] = value;
    }
    const client = target.protocol === 'https:' ? https : http;
    const proxyReq = client.request(target, { method: req.method, headers }, (proxyRes: IncomingMessage) => {
      if (res.destroyed) {
        proxyRes.destroy();
        return;
      }
      const outHeaders: OutgoingHttpHeaders = {};
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = proxyRes.headers[name];
        if (value == null) continue;
        outHeaders[name] = name === 'location' ? rewriteLocation(String(value), site, prefix) : value;
      }
      // The operator's headers win over the upstream's
      Object.assign(outHeaders, site.headers);
      res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
      pipeline(proxyRes, res, (err: NodeJS.ErrnoException | null) => {
        if (err != null) logger.debug(`[hosted-sites] ${site.name}: response ended early ${req.url}: ${err.code ?? err.message}`);
      });
    });

    let upstreamTimedOut = false;
    proxyReq.setTimeout(upstreamIdleTimeoutMs, () => {
      upstreamTimedOut = true;
      proxyReq.destroy();
      if (res.destroyed) return;
      logger.warn(`[hosted-sites] ${site.name}: upstream idle for ${upstreamIdleTimeoutMs} ms ${req.url}`);
      if (!res.headersSent) plain(res, 504, 'Gateway Timeout', {}, req.method === 'HEAD');
      else res.destroy();
    });
    proxyReq.on('error', (err: Error) => {
      if (upstreamTimedOut || res.destroyed) {
        logger.debug(`[hosted-sites] ${site.name}: upstream request dropped ${req.url}: ${err.message}`);
        return;
      }
      logger.warn(`[hosted-sites] ${site.name}: upstream error ${req.url}: ${err.message}`);
      if (!res.headersSent) plain(res, 502, 'Bad Gateway', {}, req.method === 'HEAD');
      else res.destroy();
    });
    // The client left before the answer was complete: release the upstream.
    res.once('close', () => {
      if (!res.writableFinished) proxyReq.destroy();
    });
    proxyReq.end();
  }

  // -------------------------------------------------------------- dispatch

  return function dispatch (req: IncomingMessage, res: ServerResponse, fallback: Fallback): void {
    const m = match(req);
    if (m == null) {
      fallback(req, res);
      return;
    }
    // Sites take no request body: discard whatever came so the client can finish.
    req.resume();
    if ('redirect' in m) {
      res.writeHead(301, { location: m.redirect, 'content-length': 0 });
      res.end();
      return;
    }
    const { site, subPath, search, prefix } = m;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      setSiteHeaders(req, res, site);
      plain(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
      return;
    }
    if (site.kind === 'proxy') {
      proxy(req, res, site, subPath, search, prefix);
      return;
    }
    setSiteHeaders(req, res, site);
    serveStatic(req, res, site, subPath, search, prefix).catch((err: Error) => {
      logger.warn(`[hosted-sites] ${site.name}: ${err.message}`);
      if (!res.headersSent) plain(res, 500, 'Internal Server Error', {}, req.method === 'HEAD');
      else res.destroy();
    });
  };
}

/**
 * Boot check for static sites: the folder must exist and hold `index.html`.
 * Returns one message per failing site (empty when all are servable).
 */
function checkStaticSiteFolders (sites: Map<string, HostedSite>): string[] {
  const problems: string[] = [];
  for (const site of sites.values()) {
    if (site.kind !== 'static') continue;
    let ok = false;
    try { ok = fs.statSync(path.join(site.root, 'index.html')).isFile(); } catch { ok = false; }
    if (!ok) problems.push(`hostedSites.${site.name}.static: ${site.root} does not exist or holds no index.html`);
  }
  return problems;
}

/**
 * Every boot check a hosted site needs: servable folders, no core of the
 * platform whose id is a site name (the site would take over
 * `<coreId>.<domain>`), and no existing user holding a site name (it would
 * take over that user's subdomain). Returns one message per problem (empty
 * when the core may start).
 */
async function checkHostedSitesAtBoot (
  sites: Map<string, HostedSite>,
  usersRepository: { usernameExistsOnPlatform: (username: string) => Promise<boolean> },
  platform: { getAllCoreInfos: () => Promise<Array<{ id?: string }>> }
): Promise<string[]> {
  const problems = checkStaticSiteFolders(sites);
  const coreIds = new Set((await platform.getAllCoreInfos()).map((core) => String(core.id ?? '').toLowerCase()));
  for (const name of sites.keys()) {
    if (coreIds.has(name)) {
      problems.push(`hostedSites.${name}: "${name}" is the id of a core of this platform; pick another site name`);
    }
  }
  for (const name of sites.keys()) {
    if (await usersRepository.usernameExistsOnPlatform(name)) {
      problems.push(`hostedSites.${name}: a user named "${name}" already exists; rename that user or pick another site name`);
    }
  }
  return problems;
}

export { buildHostedSitesIngress, checkStaticSiteFolders, checkHostedSitesAtBoot };
