/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


/**
 * Optional DNS server for resolving {username}.{domain} to core IPs.
 * Uses dns2 for wire protocol handling. Runs in-process in master.js.
 */

import { createRequire } from 'node:module';
import type { ConfigLike as BoilerConfig } from '@pryv/boiler';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);

const dns2 = require('dns2');
const { Packet } = dns2;
const { buildA, buildAAAA, buildCNAME, buildMX, buildNS, buildSOA, buildTXT, buildCAA } = require('./records.ts');

/**
 * Default interval for refreshing runtime DNS records from PlatformDB.
 * Multi-core deployments rely on this for Core B to see a record created on Core A.
 * ACME challenges are typically valid for >= 1 hour, so 30s is plenty.
 * Set via opts.platformRefreshIntervalMs (tests use a shorter value).
 */
const DEFAULT_PLATFORM_REFRESH_INTERVAL_MS = 30000;

/**
 * Subdomains that are part of the open-pryv.io distribution surface: every
 * core answers these endpoints directly (`/reg/*`, `/reg/access/*`, `/mfa/*`
 * are all routes inside master.js in v2). The embedded DNS resolves
 * them to ALL available cores' IPs so clients can round-robin across the
 * cluster without the operator having to maintain explicit staticEntries.
 * Operators keep full control over non-reserved names via
 * `dns.staticEntries` (e.g. `sw`, `mail`, vanity subdomains).
 *
 */
const RESERVED_SERVICE_NAMES = ['reg', 'access', 'mfa'];


/**
 * TCP connections that stay idle this long are dropped (RFC 7766 section 6.2.3
 * recommends a short idle timeout so idle clients cannot exhaust connections).
 */
const TCP_IDLE_TIMEOUT_MS = 10000;

/** DNS response codes used here (RFC 1035 section 4.1.1). */
const RCODE_NXDOMAIN = 3;
const RCODE_REFUSED = 5;
const RCODE_SERVFAIL = 2;

type DnsAnswer = Record<string, unknown>;
type DnsQuestion = { name: string; type: number };
type DnsHeader = { rcode: number; aa: number; ra: number; z: number; tc: number };
type DnsRequest = { questions: DnsQuestion[] };
type DnsResponse = { header: DnsHeader; questions: DnsQuestion[]; answers: DnsAnswer[]; authorities: DnsAnswer[] };
type DnsSendFn = (resp: DnsResponse) => void;
type Dns2EventHandler = (...args: unknown[]) => void;
type SocketAddress = { address: string; port: number };
/** The part of a dgram.Socket / net.Server (dns2 UDP and TCP servers extend them) used here. */
interface Dns2Listener {
  on: (event: string, handler: Dns2EventHandler) => unknown;
  once: (event: string, handler: Dns2EventHandler) => unknown;
  removeListener: (event: string, handler: Dns2EventHandler) => unknown;
  listen: (...args: unknown[]) => unknown;
  close: () => unknown;
  address: () => SocketAddress | string | null;
}
type ListenerKind = 'udp' | 'tcp' | 'udp6' | 'tcp6';
type SoaRecord = { primary: string; admin: string; serial: number; refresh: number; retry: number; expiration: number; minimum: number };

type DnsRecordEntry = {
  a?: string | string[];
  aaaa?: string | string[];
  cname?: string;
  txt?: string | string[];
};
type CoreInfo = { ip?: string; ipv6?: string; cname?: string; [k: string]: unknown };
type PlatformLike = {
  getAllDnsRecords?: () => Promise<Array<{ subdomain: string; records: DnsRecordEntry }>>;
  setDnsRecord?: (subdomain: string, records: DnsRecordEntry) => Promise<unknown>;
  deleteDnsRecord?: (subdomain: string) => Promise<unknown>;
  getAllCoreInfos: () => Promise<CoreInfo[]>;
  getCoreInfo: (coreId: string) => Promise<CoreInfo | null>;
  getUserCore: (username: string) => Promise<string | null>;
};

class DnsServer {
  #config: BoilerConfig;
  #platform: PlatformLike;
  #logger: Logger;
  #listeners: Map<ListenerKind, Dns2Listener> = new Map();
  #domain: string;
  #ttl: number;
  #rootRecords: Record<string, unknown>;
  #staticEntries: Record<string, DnsRecordEntry>;       // working map: config entries + runtime entries
  #configKeys: Set<string>;          // Set of subdomain keys that came from YAML config (immutable)
  #platformRefreshTimer: NodeJS.Timeout | null = null;
  #platformRefreshIntervalMs: number;
  #tcpIdleTimeoutMs: number;

  /**
   * @param opts.config - @pryv/boiler config
   * @param opts.platform - Platform instance (needs getAllDnsRecords/setDnsRecord/deleteDnsRecord for persistence; DNS-record methods are optional — absence disables PlatformDB persistence)
   * @param opts.logger - logger with .info/.warn/.error
   * @param [opts.platformRefreshIntervalMs] - override refresh interval (tests)
   * @param [opts.tcpIdleTimeoutMs] - override the TCP idle timeout (tests)
   */
  constructor ({ config, platform, logger, platformRefreshIntervalMs, tcpIdleTimeoutMs }: { config: BoilerConfig; platform: PlatformLike; logger: Logger; platformRefreshIntervalMs?: number; tcpIdleTimeoutMs?: number }) {
    this.#config = config;
    this.#platform = platform;
    this.#logger = logger;
    this.#domain = config.get('dns:domain') as string;
    this.#ttl = (config.get('dns:defaultTTL') as number) || 300;
    this.#rootRecords = (config.get('dns:records:root') as Record<string, unknown>) || {};
    // Deep-copy static entries from config so runtime updates don't mutate config
    const configEntries = (config.get('dns:staticEntries') as Record<string, DnsRecordEntry>) || {};
    this.#staticEntries = Object.assign({}, configEntries);
    this.#configKeys = new Set(Object.keys(configEntries));
    this.#platformRefreshIntervalMs = platformRefreshIntervalMs ?? DEFAULT_PLATFORM_REFRESH_INTERVAL_MS;
    this.#tcpIdleTimeoutMs = tcpIdleTimeoutMs ?? TCP_IDLE_TIMEOUT_MS;
  }

  /**
   * Start the DNS server: UDP and TCP (RFC 7766 makes TCP mandatory) on the
   * same port and address, plus the same pair on the IPv6 address if set.
   * Rejects if any socket fails to bind (port taken, missing capability) so
   * the process fails fast instead of hanging.
   * @param opts.port - UDP and TCP port
   * @param opts.ip - bind address (e.g. '0.0.0.0')
   * @param opts.ip6 - IPv6 bind address (null = disabled)
   */
  async start ({ port, ip, ip6 }: { port: number; ip: string; ip6?: string | null }) {
    if (this.#getSoa() == null) {
      this.#logger.warn('DNS: dns.records.root.soa is not set; negative answers carry no SOA ' +
        '(RFC 2308), and resolvers such as Unbound 1.18+ discard them');
    }
    try {
      await this.#listen('udp', dns2.createUDPServer({ type: 'udp4' }), (s) => s.listen(port, ip), `${ip}:${port}`);
      await this.#listen('tcp', dns2.createTCPServer(), (s) => s.listen(port, ip), `${ip}:${port}`);
      this.#logger.info(`DNS server listening on ${ip}:${port} udp+tcp (domain: ${this.#domain})`);
      if (ip6) {
        await this.#listen('udp6', dns2.createUDPServer({ type: 'udp6' }), (s) => s.listen(port, ip6), `[${ip6}]:${port}`);
        // ipv6Only: a dual-stack '::' listener would collide with the IPv4 one.
        await this.#listen('tcp6', dns2.createTCPServer(), (s) => s.listen({ port, host: ip6, ipv6Only: true }), `[${ip6}]:${port}`);
        this.#logger.info(`DNS server listening on [${ip6}]:${port} udp+tcp (IPv6)`);
      }
    } catch (err) {
      await this.#closeListeners();
      throw err;
    }

    // Load runtime DNS records from PlatformDB and start periodic
    // refresh. Multi-core: Core B picks up records created on Core A
    // via PlatformDB replication.
    await this.refreshFromPlatform();
    if (this.#platformRefreshIntervalMs > 0) {
      this.#platformRefreshTimer = setInterval(() => {
        this.refreshFromPlatform().catch((err: Error) => {
          this.#logger.warn('DNS platform refresh failed: ' + err.message);
        });
      }, this.#platformRefreshIntervalMs);
      // Don't block process exit on this timer
      if (this.#platformRefreshTimer && typeof this.#platformRefreshTimer.unref === 'function') {
        this.#platformRefreshTimer.unref();
      }
    }
  }

  /**
   * Reload runtime DNS records from PlatformDB. Config entries are authoritative —
   * they are NOT overwritten. Runtime entries that no longer exist in PlatformDB
   * are removed from the in-memory map.
   *
   * No-op if the platform instance doesn't expose `getAllDnsRecords` (allows the
   * DnsServer to be used with a minimal platform mock in tests).
   */
  async refreshFromPlatform () {
    if (!this.#platform || typeof this.#platform.getAllDnsRecords !== 'function') {
      return;
    }
    const persisted = await this.#platform.getAllDnsRecords!();
    const seenSubdomains = new Set<string>();
    for (const { subdomain, records } of persisted) {
      if (this.#configKeys.has(subdomain)) {
        // Config wins — log drift once per refresh if different
        this.#logger.warn(
          `DNS runtime record for '${subdomain}' is shadowed by config static entry; ignoring PlatformDB value`
        );
        continue;
      }
      this.#staticEntries[subdomain] = records;
      seenSubdomains.add(subdomain);
    }
    // Prune in-memory runtime entries that were deleted from PlatformDB
    for (const key of Object.keys(this.#staticEntries)) {
      if (this.#configKeys.has(key)) continue;
      if (!seenSubdomains.has(key)) {
        delete this.#staticEntries[key];
      }
    }
  }

  /**
   * Get server addresses (for tests using ephemeral ports).
   */
  _getAddresses () {
    const addresses: Partial<Record<ListenerKind, SocketAddress>> = {};
    for (const [kind, listener] of this.#listeners) {
      addresses[kind] = listener.address() as SocketAddress;
    }
    return addresses;
  }

  /**
   * Stop the DNS server.
   */
  async stop () {
    if (this.#platformRefreshTimer) {
      clearInterval(this.#platformRefreshTimer);
      this.#platformRefreshTimer = null;
    }
    if (this.#listeners.size > 0) {
      await this.#closeListeners();
      this.#logger.info('DNS server stopped');
    }
  }

  /**
   * Bind one dns2 UDP or TCP server and wire it to the request handler.
   * dns2's own `listen()` resolves on 'listening' and never rejects, so a bind
   * error would leave the caller waiting forever: race 'listening' against
   * 'error' instead.
   */
  async #listen (kind: ListenerKind, listener: Dns2Listener, doListen: (l: Dns2Listener) => unknown, where: string) {
    listener.on('request', (...args: unknown[]) => {
      const [request, send, rinfo] = args as [DnsRequest, DnsSendFn, unknown];
      this.#handleRequest(request, send, rinfo);
    });
    listener.on('requestError', (...args: unknown[]) => {
      this.#logger.warn(`DNS ${kind} request parse error: ${(args[0] as Error).message}`);
    });
    if (kind === 'tcp' || kind === 'tcp6') {
      listener.on('connection', (...args: unknown[]) => {
        const client = args[0] as { setTimeout: (ms: number, cb: () => void) => void; destroy: () => void };
        client.setTimeout(this.#tcpIdleTimeoutMs, () => client.destroy());
      });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (...args: unknown[]) => {
        listener.removeListener('listening', onListening);
        reject(new Error(`DNS server failed to bind ${kind} ${where}: ${(args[0] as Error).message}`));
      };
      const onListening = () => {
        listener.removeListener('error', onError);
        resolve();
      };
      listener.once('error', onError);
      listener.once('listening', onListening);
      this.#listeners.set(kind, listener);
      doListen(listener);
    });
    listener.on('error', (...args: unknown[]) => {
      this.#logger.error(`DNS ${kind} server error: ${(args[0] as Error).message}`);
    });
  }

  /**
   * Close every bound socket; tolerate sockets that never finished binding.
   */
  async #closeListeners () {
    const closing = [];
    for (const listener of this.#listeners.values()) {
      closing.push(new Promise<void>((resolve) => {
        listener.once('close', () => resolve());
        try {
          listener.close();
        } catch {
          resolve();
        }
      }));
    }
    this.#listeners.clear();
    await Promise.all(closing);
  }

  /**
   * Update a runtime DNS entry at runtime (e.g. from admin API / ACME).
   * Persists the record to PlatformDB when the platform exposes `setDnsRecord`,
   * so it survives restart and replicates to other cores.
   * Config-sourced static entries are authoritative and cannot be shadowed —
   * an attempt to update one throws an error.
   *
   * @param subdomain - e.g. '_acme-challenge'
   * @param records - e.g. { txt: ['validation-token'] } or { cname: 'target.example.com' }
   */
  async updateStaticEntry (subdomain: string, records: DnsRecordEntry) {
    if (this.#configKeys.has(subdomain)) {
      const msg = `DNS runtime update rejected: '${subdomain}' is a config-static entry and cannot be overwritten at runtime`;
      this.#logger.warn(msg);
      throw new Error(msg);
    }
    if (this.#platform && typeof this.#platform.setDnsRecord === 'function') {
      await this.#platform.setDnsRecord(subdomain, records);
    }
    this.#staticEntries[subdomain] = records;
    this.#logger.info(`DNS runtime entry updated: ${subdomain}`);
  }

  /**
   * Delete a runtime DNS entry. No-op for config-sourced static entries.
   */
  async deleteStaticEntry (subdomain: string) {
    if (this.#configKeys.has(subdomain)) {
      const msg = `DNS runtime delete rejected: '${subdomain}' is a config-static entry`;
      this.#logger.warn(msg);
      throw new Error(msg);
    }
    if (this.#platform && typeof this.#platform.deleteDnsRecord === 'function') {
      await this.#platform.deleteDnsRecord(subdomain);
    }
    delete this.#staticEntries[subdomain];
    this.#logger.info(`DNS runtime entry deleted: ${subdomain}`);
  }

  /**
   * Handle an incoming DNS request.
   */
  async #handleRequest (request: DnsRequest, send: DnsSendFn, _rinfo: unknown) {
    // dns2 builds the response in place from the request object: it echoes the
    // request header (including the Z/AD/CD bits) and any records the query
    // carried. Reset what an authoritative-only server must set itself.
    const response: DnsResponse = Packet.createResponseFromRequest(request);
    response.header.aa = 1;
    response.header.ra = 0;
    response.header.z = 0;
    response.header.tc = 0;
    response.header.rcode = 0;
    response.answers = [];
    response.authorities = [];
    const question = request.questions[0];
    if (!question) {
      send(response);
      return;
    }

    const qname = question.name.toLowerCase();
    const qtype = question.type;
    const domain = (this.#domain || '').toLowerCase();

    if (!domain || !(qname === domain || qname.endsWith('.' + domain))) {
      // Not a zone we serve: REFUSED, not authoritative, no SOA (answering
      // NXDOMAIN would be a claim about someone else's zone).
      response.header.aa = 0;
      response.header.rcode = RCODE_REFUSED;
      send(response);
      return;
    }

    try {
      const prefix = qname === domain ? '' : qname.slice(0, -(domain.length + 1)); // strip '.domain'

      if (prefix === '') {
        // Root domain query
        this.#answerRoot(response, qname, qtype);
      } else if (prefix === 'lsc') {
        // Cluster discovery: return all core IPs
        await this.#answerClusterDiscovery(response, qname, qtype);
      } else if (RESERVED_SERVICE_NAMES.includes(prefix)) {
        // Distribution-reserved service subdomains (reg/access/mfa): every
        // core serves these routes, so return all cores' IPs. Takes
        // precedence over operator-provided staticEntries with the same
        // name to keep behaviour consistent across deployments.
        await this.#answerClusterDiscovery(response, qname, qtype);
      } else if (this.#staticEntries[prefix]) {
        // Static subdomain (www, sw, reg, _acme-challenge, etc.). Operator
        // overrides win over PlatformDB-derived core entries below.
        this.#answerStatic(response, qname, qtype, this.#staticEntries[prefix]);
      } else if (await this.#tryAnswerCoreInfo(response, qname, qtype, prefix)) {
        // Was a `<coreId>.<domain>` query — answered from PlatformDB.
      } else {
        // Assume it's a username — look up the user's core
        await this.#answerUsername(response, qname, qtype, prefix);
      }
    } catch (err: unknown) {
      this.#logger.warn(`DNS error for ${qname}: ${(err as Error).message}`);
      // An internal failure is not a statement that the name does not exist:
      // SERVFAIL is not cached as a negative answer and makes resolvers try
      // the other nameservers (RFC 2308 section 7.1).
      response.answers = [];
      response.header.rcode = RCODE_SERVFAIL;
    }

    // RFC 2308 section 3: NXDOMAIN and NODATA answers carry the zone SOA in
    // the AUTHORITY section so resolvers can cache the negative answer.
    if (response.header.rcode === RCODE_NXDOMAIN ||
        (response.header.rcode === 0 && response.answers.length === 0)) {
      this.#addNegativeSoa(response, domain);
    }

    send(response);
  }

  /**
   * The apex SOA from `dns.records.root.soa` (YAML or seeded at boot), or null.
   */
  #getSoa (): SoaRecord | null {
    const soa = (this.#rootRecords as { soa?: SoaRecord | null }).soa;
    return soa || null;
  }

  /**
   * Put the apex SOA in AUTHORITY with the negative-caching TTL
   * min(SOA ttl, SOA minimum) (RFC 2308 section 5). No-op without a SOA.
   */
  #addNegativeSoa (response: DnsResponse, apex: string) {
    const soa = this.#getSoa();
    if (soa == null) return;
    const minimum = Number(soa.minimum);
    const negTtl = Number.isFinite(minimum) ? Math.min(this.#ttl, minimum) : this.#ttl;
    response.authorities.push(buildSOA(apex, soa, negTtl));
  }

  /**
   * Answer root domain queries with configured records.
   */
  #answerRoot (response: DnsResponse, qname: string, qtype: number) {
    const root = this.#rootRecords as Record<string, unknown> & {
      a?: string[]; aaaa?: string[]; ns?: string[]; mx?: Array<{ exchange: string; priority?: number }>; txt?: string[]; caa?: Array<{ flags?: number; tag: string; value: string }>; soa?: Record<string, unknown>;
    };
    const ttl = this.#ttl;

    if (qtype === Packet.TYPE.A || qtype === Packet.TYPE.ANY) {
      for (const addr of (root.a || [])) {
        response.answers.push(buildA(qname, addr, ttl));
      }
    }
    if (qtype === Packet.TYPE.AAAA || qtype === Packet.TYPE.ANY) {
      for (const addr of (root.aaaa || [])) {
        response.answers.push(buildAAAA(qname, addr, ttl));
      }
    }
    if (qtype === Packet.TYPE.NS || qtype === Packet.TYPE.ANY) {
      for (const ns of (root.ns || [])) {
        response.answers.push(buildNS(qname, ns, ttl));
      }
    }
    if (qtype === Packet.TYPE.MX || qtype === Packet.TYPE.ANY) {
      for (const mx of (root.mx || [])) {
        response.answers.push(buildMX(qname, mx.exchange, mx.priority || 10, ttl));
      }
    }
    if (qtype === Packet.TYPE.TXT || qtype === Packet.TYPE.ANY) {
      for (const txt of (root.txt || [])) {
        response.answers.push(buildTXT(qname, txt, ttl));
      }
    }
    if (qtype === Packet.TYPE.CAA || qtype === Packet.TYPE.ANY) {
      for (const caa of (root.caa || [])) {
        response.answers.push(buildCAA(qname, caa.flags || 0, caa.tag, caa.value, ttl));
      }
    }
    if (qtype === Packet.TYPE.SOA || qtype === Packet.TYPE.ANY) {
      if (root.soa) {
        response.answers.push(buildSOA(qname, root.soa, ttl));
      }
    }
  }

  /**
   * Answer lsc.{domain} — return all core IPs for rqlite cluster discovery.
   */
  async #answerClusterDiscovery (response: DnsResponse, qname: string, qtype: number) {
    const cores = await this.#platform.getAllCoreInfos();
    const ttl = this.#ttl;

    for (const core of cores) {
      if ((qtype === Packet.TYPE.A || qtype === Packet.TYPE.ANY) && core.ip) {
        response.answers.push(buildA(qname, core.ip, ttl));
      }
      if ((qtype === Packet.TYPE.AAAA || qtype === Packet.TYPE.ANY) && core.ipv6) {
        response.answers.push(buildAAAA(qname, core.ipv6, ttl));
      }
    }
  }

  /**
   * Answer a static subdomain entry.
   */
  #answerStatic (response: DnsResponse, qname: string, qtype: number, entry: DnsRecordEntry) {
    const ttl = this.#ttl;

    // RFC 1034 §3.6.2: a name that has a CNAME has no other data, and the
    // CNAME answers every query type (the resolver follows it for AAAA, TXT,
    // MX, ...). Never mix other records for the same name.
    if (entry.cname) {
      response.answers.push(buildCNAME(qname, entry.cname, ttl));
      return;
    }
    if (entry.a) {
      for (const addr of (Array.isArray(entry.a) ? entry.a : [entry.a])) {
        if (qtype === Packet.TYPE.A || qtype === Packet.TYPE.ANY) {
          response.answers.push(buildA(qname, addr, ttl));
        }
      }
    }
    if (entry.aaaa) {
      for (const addr of (Array.isArray(entry.aaaa) ? entry.aaaa : [entry.aaaa])) {
        if (qtype === Packet.TYPE.AAAA || qtype === Packet.TYPE.ANY) {
          response.answers.push(buildAAAA(qname, addr, ttl));
        }
      }
    }
    if (entry.txt) {
      for (const txt of (Array.isArray(entry.txt) ? entry.txt : [entry.txt])) {
        if (qtype === Packet.TYPE.TXT || qtype === Packet.TYPE.ANY) {
          response.answers.push(buildTXT(qname, txt, ttl));
        }
      }
    }
  }

  /**
   * Answer {username}.{domain} — look up user's core, return its IP or CNAME.
   */
  async #answerUsername (response: DnsResponse, qname: string, qtype: number, username: string) {
    const coreId = await this.#platform.getUserCore(username);
    if (coreId == null) {
      this.#setNxdomain(response);
      return;
    }

    const coreInfo = await this.#platform.getCoreInfo(coreId);
    if (coreInfo == null) {
      this.#setNxdomain(response);
      return;
    }

    this.#emitCoreInfoRecords(response, qname, qtype, coreInfo);
  }

  /**
   * Try to answer a `<coreId>.<domain>` query from PlatformDB. Returns true
   * iff a core is registered under `prefix` (records emitted, response is
   * "owned" by this branch) and false otherwise (caller falls through to
   * the username path).
   *
   * Without this branch the hostname advertised in `hostings.*.availableCore`
   * — and used for inter-core HTTP routing in multi-core — is unreachable
   * via the embedded DNS unless the operator pre-populates `dns.staticEntries`.
   */
  async #tryAnswerCoreInfo (response: DnsResponse, qname: string, qtype: number, prefix: string) {
    const coreInfo = await this.#platform.getCoreInfo(prefix);
    if (coreInfo == null) return false;
    this.#emitCoreInfoRecords(response, qname, qtype, coreInfo);
    return true;
  }

  /**
   * Emit A / AAAA / CNAME from a coreInfo row.
   */
  #emitCoreInfoRecords (response: DnsResponse, qname: string, qtype: number, coreInfo: CoreInfo) {
    const ttl = this.#ttl;

    if (coreInfo.ip && (qtype === Packet.TYPE.A || qtype === Packet.TYPE.ANY)) {
      response.answers.push(buildA(qname, coreInfo.ip, ttl));
    }
    if (coreInfo.ipv6 && (qtype === Packet.TYPE.AAAA || qtype === Packet.TYPE.ANY)) {
      response.answers.push(buildAAAA(qname, coreInfo.ipv6, ttl));
    }
    // A core reached by CNAME only (no ip / ipv6): the CNAME answers every
    // query type (RFC 1034 §3.6.2), so an AAAA or TXT lookup follows it too.
    if (coreInfo.cname && !coreInfo.ip && !coreInfo.ipv6) {
      response.answers.push(buildCNAME(qname, coreInfo.cname, ttl));
    }
  }

  /**
   * Set NXDOMAIN (rcode 3) on response.
   */
  #setNxdomain (response: { header: { rcode: number } }) {
    response.header.rcode = 3; // NXDOMAIN
  }
}

/**
 * Factory function.
 */
function createDnsServer ({ config, platform, logger, platformRefreshIntervalMs, tcpIdleTimeoutMs }: { config: BoilerConfig; platform: PlatformLike; logger: Logger; platformRefreshIntervalMs?: number; tcpIdleTimeoutMs?: number }) {
  return new DnsServer({ config, platform, logger, platformRefreshIntervalMs, tcpIdleTimeoutMs });
}

export { DnsServer, createDnsServer };
