/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import net from 'node:net';

/**
 * Adapter routes: a sidecar on the same host (a resource server for this
 * core's accounts) reached under `/adapter/<name>/` on every host the core
 * serves, in both topologies.
 *
 *   adapterRoutes:
 *     calendar:
 *       upstream: http://172.17.0.1:7450
 *       paths: ['/adapter/calendar/', '/.well-known/oauth-protected-resource/adapter/calendar/']
 *       maxBodyBytes: 1048576
 *       idleTimeoutMs: 60000
 *
 * A route may claim only `/adapter/<name>/...` and
 * `/.well-known/<label>/adapter/<name>/...`: no route of the core starts
 * like that, so a route cannot shadow the API. `/adapter/<name>/` is always
 * claimed. The core forwards every method, header and body to the upstream
 * and authenticates nothing on those paths: the upstream must.
 *
 * The name set and the paths are platform-wide by intent; the upstream is
 * per-core. This module is the single validator, shared by the boot-time
 * config validation, `bin/check-config.js` and the request dispatcher. Pure:
 * it reads the values it is given, never the network.
 */

type AdapterRoute = {
  name: string;
  /** The upstream origin, normalised (`http://host:port`). */
  upstream: string;
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  /** Claimed path prefixes, each ending with `/`; the first is `/adapter/<name>/`. */
  paths: string[];
  maxBodyBytes: number;
  idleTimeoutMs: number;
};

type AdapterRoutesInput = {
  /** Raw `adapterRoutes` value. */
  adapterRoutes: unknown;
  /** `dns.domain` (null when unset). */
  domain?: string | null;
  /** `dnsLess.isActive`. */
  dnsLessActive?: boolean;
  /** `dnsLess.publicUrl`, used for the upstream loop check in dnsLess mode. */
  publicUrl?: string | null;
  /** `core.url`, used for the upstream loop check. */
  coreUrl?: string | null;
  /** `http.ip`, the address this core listens on. */
  listenIp?: string | null;
  /** The ports this host's core processes listen on (`http.port`, `http.hfsPort`, `http.previewsPort`). */
  listenPorts?: number[];
};

type AdapterRoutesReport = { routes: Map<string, AdapterRoute>; problems: string[]; warnings: string[] };

const DEFAULT_MAX_BODY_BYTES = 1048576;
const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const LOW_IDLE_TIMEOUT_MS = 5000;
/** 24 h: far above any useful idle time, well below the timer limit (2^31-1 ms). */
const MAX_IDLE_TIMEOUT_MS = 86400000;

/** A DNS label: 1-63 chars, lowercase letters, digits and inner hyphens. */
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAME_MAX = 63;
const KEYS = ['upstream', 'paths', 'maxBodyBytes', 'idleTimeoutMs'];
/** The core's own `.well-known` documents: never claimable, whatever follows them. */
const CORE_WELL_KNOWN_LABELS = ['oauth-authorization-server', 'openid-configuration', 'acme-challenge'];
const WELL_KNOWN_RE = /^\/\.well-known\/([a-z0-9-]+)\/adapter\/([a-z0-9-]+)\//;

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function originOf (url: string | null | undefined): { host: string; port: string } | null {
  if (url == null || url === '') return null;
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), port: u.port || (u.protocol === 'https:' ? '443' : '80') };
  } catch { return null; }
}

/**
 * Whether clear text to this host stays on the host or its private network:
 * loopback, private and link-local addresses, `localhost`, and a single-label
 * name (a container on a shared network).
 */
function isLocalHost (hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (family === 6) {
    return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return host === 'localhost' || host.endsWith('.localhost') || !host.includes('.');
}

/** Whether the host is this machine: loopback, unspecified, `localhost`, or `listenIp`. */
function isThisMachine (hostname: string, listenIp: string | null): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (net.isIP(host) === 4 && host.startsWith('127.')) return true;
  return listenIp != null && host === listenIp.toLowerCase();
}

/** Problem with one claimed path of route `name`, or null when it is valid. */
function pathProblem (p: unknown, name: string): string | null {
  if (typeof p !== 'string' || p === '') return 'must be a non-empty string';
  if (!p.startsWith('/')) return 'must be an absolute path';
  if (/[?#]/.test(p)) return 'must not carry a query or a fragment';
  if (p.includes('%')) return 'must not hold an encoded character';
  if (p.includes('//')) return 'must not hold an empty segment';
  if (p.slice(1).split('/').some((s) => s === '.' || s === '..')) return 'must not hold a dot segment';
  if (!p.endsWith('/')) return 'must end with /';
  if (p.startsWith(`/adapter/${name}/`)) return null;
  const m = WELL_KNOWN_RE.exec(p);
  if (m != null && m[2] === name) {
    if (CORE_WELL_KNOWN_LABELS.includes(m[1])) return `/.well-known/${m[1]}/ is served by the core`;
    return null;
  }
  return `must start with /adapter/${name}/ or /.well-known/<label>/adapter/${name}/`;
}

function positiveInteger (v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/**
 * Validate the `adapterRoutes` block. Never throws: returns the valid routes
 * and the list of problems (each naming its key path) and warnings.
 */
function describeAdapterRoutes (input: AdapterRoutesInput): AdapterRoutesReport {
  const routes = new Map<string, AdapterRoute>();
  const problems: string[] = [];
  const warnings: string[] = [];
  const raw = input.adapterRoutes;
  if (raw == null) return { routes, problems, warnings };
  if (!isPlainObject(raw)) {
    problems.push('adapterRoutes must be a map of name -> { upstream, paths?, maxBodyBytes?, idleTimeoutMs? }');
    return { routes, problems, warnings };
  }
  const domain = (input.domain || '').toLowerCase() || null;
  const loopOrigins = [input.dnsLessActive === true ? originOf(input.publicUrl) : null, originOf(input.coreUrl)]
    .filter((o): o is { host: string; port: string } => o != null);
  const listenIp = input.listenIp ? String(input.listenIp) : null;
  const listenPorts = new Set((input.listenPorts || []).map(String));
  const listensEverywhere = listenIp == null || listenIp === '0.0.0.0' || listenIp === '::';

  for (const name of Object.keys(raw)) {
    const where = `adapterRoutes.${name}`;
    const routeProblems: string[] = [];
    const nameOk = name.length <= NAME_MAX && NAME_RE.test(name);
    if (!nameOk) {
      routeProblems.push(`${where}: the name must be a DNS label (1-63 lowercase letters, digits or inner hyphens)`);
    } else if (name === 'adapter') {
      routeProblems.push(`${where}: "adapter" cannot be a route name`);
    }
    const entry = raw[name];
    if (!isPlainObject(entry)) {
      problems.push(...routeProblems, `${where} must be an object with an "upstream"`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!KEYS.includes(key)) {
        routeProblems.push(`${where}.${key}: unknown key (expected ${KEYS.join(', ')})`);
      }
    }

    let upstream: URL | null = null;
    if (typeof entry.upstream !== 'string' || entry.upstream === '') {
      routeProblems.push(`${where}.upstream is required: the origin of the sidecar (e.g. http://172.17.0.1:7450)`);
    } else {
      try { upstream = new URL(entry.upstream); } catch { upstream = null; }
      if (upstream == null || !['http:', 'https:'].includes(upstream.protocol) || upstream.hostname === '') {
        routeProblems.push(`${where}.upstream must be an absolute http(s) origin without a path`);
        upstream = null;
      } else if (upstream.username !== '' || upstream.password !== '') {
        routeProblems.push(`${where}.upstream must not carry credentials`);
        upstream = null;
      } else if (upstream.pathname !== '/' || upstream.search !== '' || upstream.hash !== '' || /[?#]/.test(entry.upstream)) {
        routeProblems.push(`${where}.upstream must be an absolute http(s) origin without a path (the request path is forwarded as is)`);
        upstream = null;
      } else {
        const host = upstream.hostname.toLowerCase();
        const port = upstream.port || (upstream.protocol === 'https:' ? '443' : '80');
        if (port === '0') {
          routeProblems.push(`${where}.upstream: the port must be between 1 and 65535`);
          upstream = null;
        } else if ((domain != null && (host === domain || host.endsWith('.' + domain))) ||
            loopOrigins.some((o) => o.host === host && o.port === port)) {
          routeProblems.push(`${where}.upstream points at this platform (${host}); the request would loop back here`);
          upstream = null;
        } else if (listenPorts.has(port) && isThisMachine(host, listenIp)) {
          routeProblems.push(`${where}.upstream points at this core's own listener (${host}:${port}); the request would loop back here`);
          upstream = null;
        } else if (listenPorts.has(port) && listensEverywhere && net.isIP(upstream.hostname.replace(/^\[|\]$/g, '')) !== 0) {
          warnings.push(`${where}.upstream uses port ${port}, which this core also listens on (on every interface): if ${host} is this host, the request loops back here`);
        }
        if (upstream != null && upstream.protocol === 'http:' && !isLocalHost(host)) {
          warnings.push(`${where}.upstream uses http to ${host}, which is not a local address: the traffic, credentials included, travels in clear`);
        }
      }
    }

    const paths: string[] = nameOk ? [`/adapter/${name}/`] : [];
    if (entry.paths != null) {
      if (!Array.isArray(entry.paths)) {
        routeProblems.push(`${where}.paths must be a list of path prefixes`);
      } else {
        for (const p of entry.paths) {
          const problem = nameOk ? pathProblem(p, name) : null;
          if (problem != null) {
            routeProblems.push(`${where}.paths: ${JSON.stringify(p)} ${problem}`);
          } else if (nameOk && !paths.includes(p as string)) {
            paths.push(p as string);
          }
        }
      }
    }

    let maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
    if (entry.maxBodyBytes != null) {
      if (!positiveInteger(entry.maxBodyBytes)) routeProblems.push(`${where}.maxBodyBytes must be a positive integer (bytes)`);
      else maxBodyBytes = entry.maxBodyBytes;
    }
    let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    if (entry.idleTimeoutMs != null) {
      if (!positiveInteger(entry.idleTimeoutMs) || entry.idleTimeoutMs > MAX_IDLE_TIMEOUT_MS) {
        routeProblems.push(`${where}.idleTimeoutMs must be a positive integer (milliseconds), at most ${MAX_IDLE_TIMEOUT_MS} (24 h)`);
      } else {
        idleTimeoutMs = entry.idleTimeoutMs;
        if (idleTimeoutMs < LOW_IDLE_TIMEOUT_MS) {
          warnings.push(`${where}.idleTimeoutMs is ${idleTimeoutMs} ms: a request or a stream silent for that long is cut (504)`);
        }
      }
    }

    if (routeProblems.length > 0 || upstream == null) {
      problems.push(...routeProblems);
      continue;
    }
    routes.set(name, {
      name,
      upstream: upstream.origin,
      protocol: upstream.protocol as 'http:' | 'https:',
      hostname: upstream.hostname.replace(/^\[|\]$/g, ''),
      port: Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)),
      paths,
      maxBodyBytes,
      idleTimeoutMs
    });
  }

  // Names differ, so only a misconfigured `paths` list can make two routes overlap.
  const all = [...routes.values()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      for (const a of all[i].paths) {
        for (const b of all[j].paths) {
          if (a.startsWith(b) || b.startsWith(a)) {
            problems.push(`adapterRoutes.${all[i].name}.paths and adapterRoutes.${all[j].name}.paths overlap (${a}, ${b})`);
          }
        }
      }
    }
  }
  return { routes, problems, warnings };
}

type ConfigReader = { get: (key: string) => unknown };

/** Build the validator input from a boiler config. */
function adapterRoutesInputFromConfig (config: ConfigReader): AdapterRoutesInput {
  return {
    adapterRoutes: config.get('adapterRoutes'),
    domain: (config.get('dns:domain') as string) || null,
    dnsLessActive: config.get('dnsLess:isActive') === true,
    publicUrl: (config.get('dnsLess:publicUrl') as string) || null,
    coreUrl: (config.get('core:url') as string) || null,
    // Same defaults as the api-server, which reads these keys to listen and route.
    listenIp: (config.get('http:ip') as string) || '127.0.0.1',
    listenPorts: [config.get('http:port'), config.get('http:hfsPort') || 4000, config.get('http:previewsPort') || 3001]
      .map(Number).filter((p) => Number.isInteger(p) && p > 0)
  };
}

/**
 * Parse `adapterRoutes` from a boiler config; throws one Error listing every
 * problem. Boot paths use this once the config validation has passed.
 */
function parseAdapterRoutes (config: ConfigReader): Map<string, AdapterRoute> {
  const { routes, problems } = describeAdapterRoutes(adapterRoutesInputFromConfig(config));
  if (problems.length > 0) {
    throw new Error('Invalid adapterRoutes configuration: ' + problems.join('; '));
  }
  return routes;
}

/**
 * Boot check: with at least one route configured, no account may be named
 * `adapter` (in dnsLess its API lives under `/adapter/...`). Returns one
 * message per problem (empty when the core may start).
 */
async function checkAdapterRoutesAtBoot (
  routes: Map<string, AdapterRoute>,
  usersRepository: { usernameExistsOnPlatform: (username: string) => Promise<boolean> }
): Promise<string[]> {
  if (routes.size === 0) return [];
  if (await usersRepository.usernameExistsOnPlatform('adapter')) {
    return ['adapterRoutes: a user named "adapter" exists; rename that user (account.changeUsername) before configuring adapter routes'];
  }
  return [];
}

export { describeAdapterRoutes, adapterRoutesInputFromConfig, parseAdapterRoutes, checkAdapterRoutesAtBoot, DEFAULT_MAX_BODY_BYTES, DEFAULT_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS };
export type { AdapterRoute, AdapterRoutesInput, AdapterRoutesReport };
