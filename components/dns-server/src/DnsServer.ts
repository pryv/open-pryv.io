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


type DnsAnswer = Record<string, unknown>;
type DnsQuestion = { name: string; type: number };
type DnsRequest = { questions: DnsQuestion[] };
type DnsResponse = { answers: DnsAnswer[]; header: { rcode: number; [k: string]: unknown }; [k: string]: unknown };
type DnsSendFn = (resp: DnsResponse) => void;
type Dns2EventHandler = (...args: unknown[]) => void;
interface Dns2Server {
  on: (event: string, handler: Dns2EventHandler) => void;
  listen: (opts: { udp: { port: number; address: string; type: string } } | number, ip?: string) => Promise<void>;
  close: () => Promise<void> | void;
  addresses: () => { udp?: { address: string; port: number }; tcp?: { address: string; port: number } };
  _udp6?: Dns2Server;
}

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
  // Optional: present when platform.piiMode is wired (Plan 99 Phase B).
  // Identity in cleartext mode; HMAC-SHA-256 token in hashed mode. The
  // DnsServer uses this to keep its in-memory cache keyed in the same
  // form PlatformDB stores rows, so PlatformDB-sourced runtime entries
  // and incoming DNS query prefixes share a lookup space.
  hashFor?: (field: string, value: string) => string;
};

/** Field name used to derive the storage-form key for a DNS subdomain.
 *  Must match `SUBDOMAIN_FIELD` in components/platform/src/Platform.ts so
 *  the cache key matches the PlatformDB row key on the same value. */
const DNS_SUBDOMAIN_FIELD = 'dns-subdomain';

class DnsServer {
  #config: BoilerConfig;
  #platform: PlatformLike;
  #logger: Logger;
  #server!: Dns2Server;
  #domain: string;
  #ttl: number;
  #rootRecords: Record<string, unknown>;
  // Keys here are the PlatformDB STORAGE form of the subdomain — plaintext in
  // cleartext mode, HMAC token in hashed mode. Lookups from `#handleRequest`
  // must run incoming query prefixes through `#storageKeyFor(...)` to match.
  #staticEntries: Record<string, DnsRecordEntry>;       // working map: config entries + runtime entries
  #configKeys: Set<string>;          // Set of storage-form keys that came from YAML config (immutable)
  // Parallel plaintext map (subdomain → plaintext) for config-sourced entries.
  // Lets log/diagnostic output keep the cleartext name even when the storage
  // key is opaque. PlatformDB-sourced entries have NO plaintext available in
  // hashed mode — runtime-record diagnostics for those carry the token.
  #configKeysPlaintextByStorageKey: Map<string, string>;
  #platformRefreshTimer: NodeJS.Timeout | null = null;
  #platformRefreshIntervalMs: number;

  /**
   * @param opts.config - @pryv/boiler config
   * @param opts.platform - Platform instance (needs getAllDnsRecords/setDnsRecord/deleteDnsRecord for persistence; DNS-record methods are optional — absence disables PlatformDB persistence)
   * @param opts.logger - logger with .info/.warn/.error
   * @param [opts.platformRefreshIntervalMs] - override refresh interval (tests)
   */
  constructor ({ config, platform, logger, platformRefreshIntervalMs }: { config: BoilerConfig; platform: PlatformLike; logger: Logger; platformRefreshIntervalMs?: number }) {
    this.#config = config;
    this.#platform = platform;
    this.#logger = logger;
    this.#domain = config.get('dns:domain') as string;
    this.#ttl = (config.get('dns:defaultTTL') as number) || 300;
    this.#rootRecords = (config.get('dns:records:root') as Record<string, unknown>) || {};
    // Deep-copy static entries from config so runtime updates don't mutate config.
    // In hashed mode the cache keys are HMAC tokens so PlatformDB-sourced
    // entries (already in storage form) and config-sourced entries (rehashed
    // here from their plaintext) share a single lookup space.
    const configEntries = (config.get('dns:staticEntries') as Record<string, DnsRecordEntry>) || {};
    this.#staticEntries = {};
    this.#configKeys = new Set();
    this.#configKeysPlaintextByStorageKey = new Map();
    for (const [plaintext, records] of Object.entries(configEntries)) {
      const storageKey = this.#storageKeyFor(plaintext);
      this.#staticEntries[storageKey] = records;
      this.#configKeys.add(storageKey);
      this.#configKeysPlaintextByStorageKey.set(storageKey, plaintext);
    }
    this.#platformRefreshIntervalMs = platformRefreshIntervalMs ?? DEFAULT_PLATFORM_REFRESH_INTERVAL_MS;
  }

  /**
   * Translate a plaintext subdomain to the form PlatformDB stores it under.
   * Identity in cleartext mode (Platform's `hashFor` is the identity), HMAC
   * token in hashed mode. When the platform mock used in tests does not
   * expose `hashFor`, identity is used — matches cleartext semantics.
   */
  #storageKeyFor (subdomain: string): string {
    if (this.#platform && typeof this.#platform.hashFor === 'function') {
      return this.#platform.hashFor(DNS_SUBDOMAIN_FIELD, subdomain);
    }
    return subdomain;
  }

  /**
   * Start the DNS server.
   * @param opts.port - UDP port
   * @param opts.ip - bind address (e.g. '0.0.0.0')
   * @param opts.ip6 - IPv6 bind address (null = disabled)
   */
  async start ({ port, ip, ip6 }: { port: number; ip: string; ip6?: string | null }) {
    this.#server = dns2.createServer({
      udp: true,
      handle: (request: DnsRequest, send: DnsSendFn, rinfo: unknown) => {
        this.#handleRequest(request, send, rinfo);
      }
    });

    this.#server.on('requestError', (...args: unknown[]) => {
      const err = args[0] as Error;
      this.#logger.warn('DNS request parse error: ' + err.message);
    });

    this.#server.on('error', (...args: unknown[]) => {
      const err = args[0] as Error;
      this.#logger.error('DNS server error: ' + err.message);
    });

    const listenOpts = {
      udp: { port, address: ip, type: 'udp4' }
    };

    await this.#server.listen(listenOpts);
    this.#logger.info(`DNS server listening on ${ip}:${port} (domain: ${this.#domain})`);

    // If IPv6 is configured, start a second UDP6 server
    if (ip6) {
      this.#server._udp6 = dns2.createUDPServer({ type: 'udp6' });
      this.#server._udp6!.on('request', (...args: unknown[]) => {
        const [request, send, rinfo] = args as [DnsRequest, DnsSendFn, unknown];
        this.#handleRequest(request, send, rinfo);
      });
      await this.#server._udp6!.listen(port, ip6);
      this.#logger.info(`DNS server listening on [${ip6}]:${port} (IPv6)`);
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
    // `subdomain` in each row is already in storage form (HMAC in hashed
    // mode, plaintext in cleartext). It matches `#configKeys` directly —
    // both are storage form thanks to the constructor's hashing pass.
    const seenStorageKeys = new Set<string>();
    for (const { subdomain: storageKey, records } of persisted) {
      if (this.#configKeys.has(storageKey)) {
        const plaintextOrToken = this.#configKeysPlaintextByStorageKey.get(storageKey) ?? storageKey;
        this.#logger.warn(
          `DNS runtime record for '${plaintextOrToken}' is shadowed by config static entry; ignoring PlatformDB value`
        );
        continue;
      }
      this.#staticEntries[storageKey] = records;
      seenStorageKeys.add(storageKey);
    }
    // Prune in-memory runtime entries that were deleted from PlatformDB
    for (const key of Object.keys(this.#staticEntries)) {
      if (this.#configKeys.has(key)) continue;
      if (!seenStorageKeys.has(key)) {
        delete this.#staticEntries[key];
      }
    }
  }

  /**
   * Get server addresses (for tests using ephemeral ports).
   */
  _getAddresses () {
    return this.#server.addresses();
  }

  /**
   * Stop the DNS server.
   */
  async stop () {
    if (this.#platformRefreshTimer) {
      clearInterval(this.#platformRefreshTimer);
      this.#platformRefreshTimer = null;
    }
    if (this.#server) {
      if (this.#server._udp6) {
        this.#server._udp6.close();
      }
      await this.#server.close();
      this.#logger.info('DNS server stopped');
    }
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
    // Callers pass plaintext subdomain (operator/ACME orchestrator side).
    // The cache + config-shadow check use storage form so both modes work.
    const storageKey = this.#storageKeyFor(subdomain);
    if (this.#configKeys.has(storageKey)) {
      const msg = `DNS runtime update rejected: '${subdomain}' is a config-static entry and cannot be overwritten at runtime`;
      this.#logger.warn(msg);
      throw new Error(msg);
    }
    if (this.#platform && typeof this.#platform.setDnsRecord === 'function') {
      // Platform.setDnsRecord hashes the subdomain internally (Phase B.2) so
      // we pass plaintext through — single hashing point on the persistence path.
      await this.#platform.setDnsRecord(subdomain, records);
    }
    this.#staticEntries[storageKey] = records;
    this.#logger.info(`DNS runtime entry updated: ${subdomain}`);
  }

  /**
   * Delete a runtime DNS entry. No-op for config-sourced static entries.
   */
  async deleteStaticEntry (subdomain: string) {
    const storageKey = this.#storageKeyFor(subdomain);
    if (this.#configKeys.has(storageKey)) {
      const msg = `DNS runtime delete rejected: '${subdomain}' is a config-static entry`;
      this.#logger.warn(msg);
      throw new Error(msg);
    }
    if (this.#platform && typeof this.#platform.deleteDnsRecord === 'function') {
      await this.#platform.deleteDnsRecord(subdomain);
    }
    delete this.#staticEntries[storageKey];
    this.#logger.info(`DNS runtime entry deleted: ${subdomain}`);
  }

  /**
   * Handle an incoming DNS request.
   */
  async #handleRequest (request: DnsRequest, send: DnsSendFn, _rinfo: unknown) {
    const response = Packet.createResponseFromRequest(request);
    const question = request.questions[0];
    if (!question) {
      send(response);
      return;
    }

    const qname = question.name.toLowerCase();
    const qtype = question.type;

    try {
      if (!this.#domain || !qname.endsWith(this.#domain.toLowerCase())) {
        // Not our domain — NXDOMAIN
        this.#setNxdomain(response);
        send(response);
        return;
      }

      const prefix = qname.slice(0, -(this.#domain.length + 1)); // strip '.domain'

      if (prefix === '' || qname === this.#domain.toLowerCase()) {
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
      } else if (this.#staticEntries[this.#storageKeyFor(prefix)]) {
        // Static subdomain (www, sw, reg, _acme-challenge, etc.). Operator
        // overrides win over PlatformDB-derived core entries below.
        // The cache is keyed in storage form (Phase B.3) so we hash the
        // incoming plaintext prefix to look it up.
        this.#answerStatic(response, qname, qtype, this.#staticEntries[this.#storageKeyFor(prefix)]);
      } else if (await this.#tryAnswerCoreInfo(response, qname, qtype, prefix)) {
        // Was a `<coreId>.<domain>` query — answered from PlatformDB.
      } else {
        // Assume it's a username — look up the user's core
        await this.#answerUsername(response, qname, qtype, prefix);
      }
    } catch (err: unknown) {
      this.#logger.warn(`DNS error for ${qname}: ${(err as Error).message}`);
      this.#setNxdomain(response);
    }

    send(response);
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

    if (entry.cname && (qtype === Packet.TYPE.CNAME || qtype === Packet.TYPE.A || qtype === Packet.TYPE.ANY)) {
      response.answers.push(buildCNAME(qname, entry.cname, ttl));
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
    if (coreInfo.cname && !coreInfo.ip && !coreInfo.ipv6 &&
        (qtype === Packet.TYPE.CNAME || qtype === Packet.TYPE.A || qtype === Packet.TYPE.ANY)) {
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
function createDnsServer ({ config, platform, logger, platformRefreshIntervalMs }: { config: BoilerConfig; platform: PlatformLike; logger: Logger; platformRefreshIntervalMs?: number }) {
  return new DnsServer({ config, platform, logger, platformRefreshIntervalMs });
}

export { DnsServer, createDnsServer };
