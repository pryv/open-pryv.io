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

const dns2 = require('dns2');
const { Packet } = dns2;
const { buildA, buildAAAA, buildCNAME, buildMX, buildNS, buildSOA, buildTXT, buildCAA } = require('./records');

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
 * are all routes inside master.js since Plan 26). The embedded DNS resolves
 * them to ALL available cores' IPs so clients can round-robin across the
 * cluster without the operator having to maintain explicit staticEntries.
 * Operators keep full control over non-reserved names via
 * `dns.staticEntries` (e.g. `sw`, `mail`, vanity subdomains).
 *
 */
const RESERVED_SERVICE_NAMES = ['reg', 'access', 'mfa'];

class DnsServer {
  #config;
  #platform;
  #logger;
  #server;
  #domain;
  #ttl;
  #rootRecords;
  #staticEntries;       // working map: config entries + runtime entries
  #configKeys;          // Set of subdomain keys that came from YAML config (immutable)
  #platformRefreshTimer;
  #platformRefreshIntervalMs;

  /**
   * @param {Object} opts
   * @param {Object} opts.config - @pryv/boiler config
   * @param {Object} opts.platform - Platform instance (needs getAllDnsRecords/setDnsRecord/deleteDnsRecord for persistence; DNS-record methods are optional — absence disables PlatformDB persistence)
   * @param {Object} opts.logger - logger with .info/.warn/.error
   * @param {number} [opts.platformRefreshIntervalMs] - override refresh interval (tests)
   */
  constructor ({ config, platform, logger, platformRefreshIntervalMs }) {
    this.#config = config;
    this.#platform = platform;
    this.#logger = logger;
    this.#domain = config.get('dns:domain');
    this.#ttl = config.get('dns:defaultTTL') || 300;
    this.#rootRecords = config.get('dns:records:root') || {};
    // Deep-copy static entries from config so runtime updates don't mutate config
    const configEntries = config.get('dns:staticEntries') || {};
    this.#staticEntries = Object.assign({}, configEntries);
    this.#configKeys = new Set(Object.keys(configEntries));
    this.#platformRefreshIntervalMs = platformRefreshIntervalMs ?? DEFAULT_PLATFORM_REFRESH_INTERVAL_MS;
  }

  /**
   * Start the DNS server.
   * @param {Object} opts
   * @param {number} opts.port - UDP port
   * @param {string} opts.ip - bind address (e.g. '0.0.0.0')
   * @param {string|null} opts.ip6 - IPv6 bind address (null = disabled)
   */
  async start ({ port, ip, ip6 }) {
    this.#server = dns2.createServer({
      udp: true,
      handle: (request, send, rinfo) => {
        this.#handleRequest(request, send, rinfo);
      }
    });

    this.#server.on('requestError', (err) => {
      this.#logger.warn('DNS request parse error: ' + err.message);
    });

    this.#server.on('error', (err) => {
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
      this.#server._udp6.on('request', (request, send, rinfo) => {
        this.#handleRequest(request, send, rinfo);
      });
      await this.#server._udp6.listen(port, ip6);
      this.#logger.info(`DNS server listening on [${ip6}]:${port} (IPv6)`);
    }

    // Plan 27 Phase 1: load runtime DNS records from PlatformDB and start periodic refresh.
    // Multi-core: Core B picks up records created on Core A via PlatformDB replication.
    await this.refreshFromPlatform();
    if (this.#platformRefreshIntervalMs > 0) {
      this.#platformRefreshTimer = setInterval(() => {
        this.refreshFromPlatform().catch((err) => {
          this.#logger.warn('DNS platform refresh failed: ' + err.message);
        });
      }, this.#platformRefreshIntervalMs);
      // Don't block process exit on this timer
      if (typeof this.#platformRefreshTimer.unref === 'function') {
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
    const persisted = await this.#platform.getAllDnsRecords();
    const seenSubdomains = new Set();
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
   * @param {string} subdomain - e.g. '_acme-challenge'
   * @param {Object} records - e.g. { txt: ['validation-token'] } or { cname: 'target.example.com' }
   * @returns {Promise<void>}
   */
  async updateStaticEntry (subdomain, records) {
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
   * @param {string} subdomain
   */
  async deleteStaticEntry (subdomain) {
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
  async #handleRequest (request, send, rinfo) {
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
      } else if (this.#staticEntries[prefix]) {
        // Static subdomain (www, sw, reg, _acme-challenge, etc.)
        this.#answerStatic(response, qname, qtype, this.#staticEntries[prefix]);
      } else {
        // Assume it's a username — look up the user's core
        await this.#answerUsername(response, qname, qtype, prefix);
      }
    } catch (err) {
      this.#logger.warn(`DNS error for ${qname}: ${err.message}`);
      this.#setNxdomain(response);
    }

    send(response);
  }

  /**
   * Answer root domain queries with configured records.
   */
  #answerRoot (response, qname, qtype) {
    const root = this.#rootRecords;
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
  async #answerClusterDiscovery (response, qname, qtype) {
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
  #answerStatic (response, qname, qtype, entry) {
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
  async #answerUsername (response, qname, qtype, username) {
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
  #setNxdomain (response) {
    response.header.rcode = 3; // NXDOMAIN
  }
}

/**
 * Factory function.
 */
function createDnsServer ({ config, platform, logger, platformRefreshIntervalMs }) {
  return new DnsServer({ config, platform, logger, platformRefreshIntervalMs });
}

module.exports = { DnsServer, createDnsServer };
