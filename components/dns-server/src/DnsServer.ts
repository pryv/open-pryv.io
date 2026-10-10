/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


/**
 * Optional DNS server for resolving {username}.{domain} to core IPs.
 *
 * The server owns its own UDP (dgram) and TCP (net) listeners and validates
 * every incoming message on the raw buffer (see `wire.ts`) before anything
 * decodes it. dns2 is used only to ENCODE the response records; its decoder
 * never sees request bytes. Each request is handled in isolation: a failure is
 * caught, logged through one rate-limited aggregated warning, and answered with
 * SERVFAIL where a reply is owed, so one bad request cannot affect the server.
 * Runs in-process in master.js.
 */

import { createRequire } from 'node:module';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import type { Socket as DgramSocket, RemoteInfo } from 'node:dgram';
import type { Server as NetServer, Socket as NetSocket } from 'node:net';
import type { ConfigLike as BoilerConfig } from '@pryv/boiler';
import type { Logger } from '@pryv/boiler';
import { validateRequest, isIgnorableUdpSource } from './wire.ts';
import type { WireResult, WireHeader } from './wire.ts';
import { validateDnsRecord, isEncodableAnswer, normalizeStoredRecord } from './recordValidation.ts';
import type { EncodableAnswer } from './recordValidation.ts';
const require = createRequire(import.meta.url);

const dns2 = require('dns2');
const { Packet } = dns2;
const { buildA, buildAAAA, buildCNAME, buildMX, buildNS, buildSOA, buildTXT, buildCAA } = require('./records.ts');
const { hostedSiteNames } = require('business/src/hostedSites.ts');

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

/**
 * Absolute per-connection deadline: a TCP connection is closed after this long
 * regardless of activity, so a slow-drip client cannot hold one open by
 * resetting the idle timer.
 */
const TCP_ABSOLUTE_DEADLINE_MS = 20000;

/** Default cap on simultaneous TCP connections (config `dns.tcpMaxConnections`). */
const DEFAULT_TCP_MAX_CONNECTIONS = 64;

/** A UDP answer larger than this is sent truncated (TC=1, no records); no EDNS. */
const UDP_MAX_RESPONSE = 512;

/** A DNS message carries a 16-bit length prefix over TCP, so 65535 is the ceiling. */
const TCP_MAX_MESSAGE = 65535;

/** Window over which per-request failures are aggregated into one warning. */
const WARN_WINDOW_MS = 10000;

/** DNS response codes used here (RFC 1035 section 4.1.1). */
const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;
const RCODE_REFUSED = 5;
const RCODE_SERVFAIL = 2;

type DnsAnswer = EncodableAnswer & { name: string };
type ResponseHeader = { id: number; qr: number; opcode: number; aa: number; tc: number; rd: number; ra: number; z: number; rcode: number };
type BuiltResponse = { header: ResponseHeader; answers: DnsAnswer[]; authorities: DnsAnswer[] };
type SendFn = (buf: Buffer) => void;
type Transport = 'udp' | 'tcp';
type ListenerKind = 'udp' | 'tcp' | 'udp6' | 'tcp6';
type SocketAddress = { address: string; port: number };
type SoaRecord = { primary: string; admin: string; serial: number; refresh: number; retry: number; expiration: number; minimum: number };

type DnsRecordEntry = {
  a?: string | string[];
  aaaa?: string | string[];
  cname?: string;
  txt?: string | string[];
};
type CoreInfo = { id?: string; ip?: string; ipv6?: string; cname?: string; sites?: string[]; [k: string]: unknown };
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
  #udpSockets: Map<ListenerKind, DgramSocket> = new Map();
  #tcpServers: Map<ListenerKind, NetServer> = new Map();
  #tcpClients: Set<NetSocket> = new Set();
  #domain: string;
  #ttl: number;
  #rootRecords: Record<string, unknown>;
  #staticEntries: Map<string, DnsRecordEntry> = new Map();   // working map: config entries + runtime entries
  #configKeys: Set<string>;          // Set of subdomain keys that came from YAML config (immutable)
  #platformRefreshTimer: NodeJS.Timeout | null = null;
  #platformRefreshIntervalMs: number;
  #tcpIdleTimeoutMs: number;
  #tcpMaxConnections: number;
  #localSites: Set<string>;          // hosted-site names from this core's config
  #advertisedSites: Set<string> = new Set(); // hosted-site names advertised by any core-info row (refreshed)
  #coreId: string;
  #coreIds: Set<string> = new Set(); // ids of every core-info row (refreshed), plus this core's
  // Rate-limited aggregated per-request warning.
  #warnPending = 0;
  #warnSample: string | null = null;
  #warnTimer: NodeJS.Timeout | null = null;
  // Stored rows refused at the last refresh (JSON name -> JSON reason), so each
  // is warned about once rather than at every refresh.
  #refusedRows: Map<string, string> = new Map();

  /**
   * @param opts.config - @pryv/boiler config
   * @param opts.platform - Platform instance (needs getAllDnsRecords/setDnsRecord/deleteDnsRecord for persistence; DNS-record methods are optional — absence disables PlatformDB persistence)
   * @param opts.logger - logger with .info/.warn/.error
   * @param [opts.platformRefreshIntervalMs] - override refresh interval (tests)
   * @param [opts.tcpIdleTimeoutMs] - override the TCP idle timeout (tests)
   * @param [opts.tcpMaxConnections] - override the TCP connection cap (tests)
   */
  constructor ({ config, platform, logger, platformRefreshIntervalMs, tcpIdleTimeoutMs, tcpMaxConnections }: { config: BoilerConfig; platform: PlatformLike; logger: Logger; platformRefreshIntervalMs?: number; tcpIdleTimeoutMs?: number; tcpMaxConnections?: number }) {
    this.#config = config;
    this.#platform = platform;
    this.#logger = logger;
    this.#domain = config.get('dns:domain') as string;
    this.#ttl = (config.get('dns:defaultTTL') as number) || 300;
    this.#rootRecords = (config.get('dns:records:root') as Record<string, unknown>) || {};
    // Deep-copy static entries from config so runtime updates don't mutate config
    const configEntries = (config.get('dns:staticEntries') as Record<string, DnsRecordEntry>) || {};
    for (const [k, v] of Object.entries(configEntries)) this.#staticEntries.set(k, v);
    this.#configKeys = new Set(Object.keys(configEntries));
    this.#platformRefreshIntervalMs = platformRefreshIntervalMs ?? DEFAULT_PLATFORM_REFRESH_INTERVAL_MS;
    this.#tcpIdleTimeoutMs = tcpIdleTimeoutMs ?? TCP_IDLE_TIMEOUT_MS;
    this.#tcpMaxConnections = tcpMaxConnections ?? (config.get('dns:tcpMaxConnections') as number) ?? DEFAULT_TCP_MAX_CONNECTIONS;
    this.#localSites = new Set(hostedSiteNames(config));
    this.#coreId = (config.get('core:id') as string) || 'single';
    this.#coreIds = new Set([this.#coreId]);
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
      await this.#bindUdp('udp', 'udp4', port, ip, false, `${ip}:${port}`);
      await this.#bindTcp('tcp', port, ip, false, `${ip}:${port}`);
      this.#logger.info(`DNS server listening on ${ip}:${port} udp+tcp (domain: ${this.#domain})`);
      if (ip6) {
        // ipv6Only on both: a dual-stack '::' listener would collide with the
        // IPv4 one (EADDRINUSE on Linux).
        await this.#bindUdp('udp6', 'udp6', port, ip6, true, `[${ip6}]:${port}`);
        await this.#bindTcp('tcp6', port, ip6, true, `[${ip6}]:${port}`);
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
   * are removed from the in-memory map. A stored row is normalised first
   * (lowercase, one trailing dot stripped from the name and the CNAME target);
   * a row still invalid after that is skipped (never served) with a warning
   * naming it, logged once while it stays refused.
   *
   * No-op if the platform instance doesn't expose `getAllDnsRecords` (allows the
   * DnsServer to be used with a minimal platform mock in tests).
   */
  async refreshFromPlatform () {
    if (!this.#platform) return;
    await this.#refreshAdvertisedSites();
    if (typeof this.#platform.getAllDnsRecords !== 'function') {
      return;
    }
    const persisted = await this.#platform.getAllDnsRecords!();
    const seenSubdomains = new Set<string>();
    const refusedNow = new Map<string, string>();
    for (const row of persisted) {
      const normalized = normalizeStoredRecord(row.subdomain, row.records);
      const errs = validateDnsRecord(normalized.subdomain, normalized.records);
      if (errs.length > 0) {
        // Each refused row is reported on its own (not through the per-request
        // aggregator), once while it stays refused for the same reason.
        const name = JSON.stringify(row.subdomain);
        const reason = JSON.stringify(errs.join('; '));
        refusedNow.set(name, reason);
        if (this.#refusedRows.get(name) !== reason) {
          this.#logger.warn(`DNS: stored record ${name} is not served: ${reason}`);
        }
        continue;
      }
      const subdomain = normalized.subdomain as string;
      const records = normalized.records as DnsRecordEntry;
      if (this.#isHostedSite(subdomain)) {
        // Kept in memory (it answers again if the site goes away), never served meanwhile
        this.#logger.warn(
          `DNS runtime record for '${subdomain}' is shadowed by a hosted site with that name; ignoring PlatformDB value`
        );
      }
      if (this.#configKeys.has(subdomain)) {
        // Config wins — log drift once per refresh if different
        this.#logger.warn(
          `DNS runtime record for '${subdomain}' is shadowed by config static entry; ignoring PlatformDB value`
        );
        continue;
      }
      this.#staticEntries.set(subdomain, records);
      seenSubdomains.add(subdomain);
    }
    this.#refusedRows = refusedNow;
    // Prune in-memory runtime entries that were deleted from PlatformDB
    for (const key of [...this.#staticEntries.keys()]) {
      if (this.#configKeys.has(key)) continue;
      if (!seenSubdomains.has(key)) {
        this.#staticEntries.delete(key);
      }
    }
  }

  /**
   * Get server addresses (for tests using ephemeral ports).
   */
  _getAddresses () {
    const addresses: Partial<Record<ListenerKind, SocketAddress>> = {};
    for (const [kind, socket] of this.#udpSockets) {
      addresses[kind] = socket.address() as SocketAddress;
    }
    for (const [kind, server] of this.#tcpServers) {
      addresses[kind] = server.address() as SocketAddress;
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
    if (this.#warnTimer) {
      clearTimeout(this.#warnTimer);
      this.#warnTimer = null;
      this.#flushWarn();
    }
    if (this.#udpSockets.size > 0 || this.#tcpServers.size > 0) {
      await this.#closeListeners();
      this.#logger.info('DNS server stopped');
    }
  }

  /**
   * Bind one UDP (dgram) listener and wire it to the request handler. dgram's
   * own bind resolves on 'listening' and never rejects, so race 'listening'
   * against 'error' to surface a bind failure.
   */
  async #bindUdp (kind: ListenerKind, type: 'udp4' | 'udp6', port: number, address: string, ipv6Only: boolean, where: string) {
    const socket = ipv6Only ? createSocket({ type, ipv6Only: true }) : createSocket({ type });
    socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => { this.#onUdpMessage(socket, msg, rinfo); });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        socket.removeListener('listening', onListening);
        reject(new Error(`DNS server failed to bind ${kind} ${where}: ${err.message}`));
      };
      const onListening = () => {
        socket.removeListener('error', onError);
        resolve();
      };
      socket.once('error', onError);
      socket.once('listening', onListening);
      this.#udpSockets.set(kind, socket);
      socket.bind({ port, address });
    });
    socket.on('error', (err: Error) => this.#logger.error(`DNS ${kind} socket error: ${err.message}`));
  }

  /**
   * Bind one TCP (net) listener with a bounded reader and connection cap.
   */
  async #bindTcp (kind: ListenerKind, port: number, host: string, ipv6Only: boolean, where: string) {
    const server = createServer();
    server.maxConnections = this.#tcpMaxConnections;
    server.on('connection', (client: NetSocket) => this.#onTcpConnection(client));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(new Error(`DNS server failed to bind ${kind} ${where}: ${err.message}`));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      this.#tcpServers.set(kind, server);
      if (ipv6Only) server.listen({ port, host, ipv6Only: true });
      else server.listen(port, host);
    });
    server.on('error', (err: Error) => this.#logger.error(`DNS ${kind} server error: ${err.message}`));
  }

  /**
   * Close every bound socket and server; destroy any open TCP connection so a
   * lingering client cannot hold the close open.
   */
  async #closeListeners () {
    const closing: Array<Promise<void>> = [];
    for (const client of this.#tcpClients) {
      try { client.destroy(); } catch { /* already gone */ }
    }
    this.#tcpClients.clear();
    for (const socket of this.#udpSockets.values()) {
      closing.push(new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      }));
    }
    for (const server of this.#tcpServers.values()) {
      closing.push(new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      }));
    }
    this.#udpSockets.clear();
    this.#tcpServers.clear();
    await Promise.all(closing);
  }

  /**
   * Handle one inbound UDP datagram: drop a source port of 0, classify on the
   * raw buffer, dispatch. Every path is guarded so one datagram cannot throw
   * out of the socket callback.
   */
  #onUdpMessage (socket: DgramSocket, msg: Buffer, rinfo: RemoteInfo) {
    try {
      if (isIgnorableUdpSource(rinfo.port)) {
        this.#warnAgg('ignored', 'source port 0');
        return;
      }
      const result = validateRequest(msg);
      const send: SendFn = (buf) => {
        socket.send(buf, rinfo.port, rinfo.address, (err) => { if (err) this.#warnAgg('udp-send', err.message); });
      };
      this.#dispatchResult(result, send, 'udp')
        .catch((err: Error) => this.#warnAgg('udp-handler', err.message));
    } catch (err) {
      this.#warnAgg('udp', (err as Error).message);
    }
  }

  /**
   * Read exactly one length-prefixed message from a TCP connection, answer it,
   * and end the connection. The reader is bounded: it destroys the socket when
   * the declared length is below the header size, above the 16-bit ceiling, or
   * when extra bytes follow a complete message. An idle timeout and an absolute
   * deadline both close a stalled connection.
   */
  #onTcpConnection (client: NetSocket) {
    this.#tcpClients.add(client);
    client.setTimeout(this.#tcpIdleTimeoutMs, () => client.destroy());
    const deadline = setTimeout(() => client.destroy(), TCP_ABSOLUTE_DEADLINE_MS);
    if (typeof deadline.unref === 'function') deadline.unref();

    let buffered = Buffer.alloc(0);
    let answered = false;

    const cleanup = () => {
      clearTimeout(deadline);
      this.#tcpClients.delete(client);
    };
    client.on('error', () => { /* per-connection error: nothing to do but let it close */ });
    client.on('close', cleanup);

    client.on('data', (chunk: Buffer) => {
      if (answered) { client.destroy(); return; }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 2 + TCP_MAX_MESSAGE) { client.destroy(); return; }
      if (buffered.length < 2) return;
      const msgLen = buffered.readUInt16BE(0);
      if (msgLen < 12 || msgLen > TCP_MAX_MESSAGE) { client.destroy(); return; }
      if (buffered.length < 2 + msgLen) return; // wait for the rest
      if (buffered.length > 2 + msgLen) { client.destroy(); return; } // extra bytes follow one message
      answered = true;
      const msg = buffered.subarray(2, 2 + msgLen);
      const result = validateRequest(msg);
      let replied = false;
      const send: SendFn = (buf) => { replied = true; this.#tcpSend(client, buf); };
      this.#dispatchResult(result, send, 'tcp')
        .then(() => { if (!replied) { try { client.destroy(); } catch { /* gone */ } } })
        .catch((err: Error) => { this.#warnAgg('tcp-handler', err.message); try { client.destroy(); } catch { /* gone */ } });
    });
  }

  #tcpSend (client: NetSocket, buf: Buffer) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(buf.length);
    client.end(Buffer.concat([len, buf]));
  }

  /**
   * Map a wire classification to a reply (or no reply) and send it.
   */
  async #dispatchResult (result: WireResult, send: SendFn, transport: Transport): Promise<void> {
    switch (result.kind) {
      case 'ignore':
        this.#warnAgg('ignored', result.reason);
        return;
      case 'error':
        this.#safeSend(() => send(this.#encodeHeaderOnly(result.header, result.rcode)));
        return;
      case 'refused': {
        const header = this.#responseHeader(result.header, { aa: 0, rcode: RCODE_REFUSED });
        this.#safeSend(() => send(this.#encodeResponse(header, result.rawQuestion, [], [])));
        return;
      }
      case 'ok':
        await this.#answerOk(result, send, transport);
    }
  }

  /**
   * Build and send the answer for a conformant query. Encoding is inside the
   * try with a SERVFAIL fallback; an over-size UDP answer is truncated (TC=1,
   * no records) and an over-cap TCP answer falls back to SERVFAIL.
   */
  async #answerOk (result: Extract<WireResult, { kind: 'ok' }>, send: SendFn, transport: Transport) {
    const base = this.#responseHeader(result.header, { aa: 1, rcode: RCODE_NOERROR });
    try {
      const built = await this.#buildAnswer(result.name, result.type, base);
      let buf = this.#encodeResponse(built.header, result.rawQuestion, built.answers, built.authorities);
      if (transport === 'udp' && buf.length > UDP_MAX_RESPONSE) {
        buf = this.#encodeResponse({ ...built.header, tc: 1 }, result.rawQuestion, [], []);
      } else if (transport === 'tcp' && buf.length > TCP_MAX_MESSAGE) {
        buf = this.#encodeResponse({ ...built.header, aa: 0, tc: 0, rcode: RCODE_SERVFAIL }, result.rawQuestion, [], []);
      }
      send(buf);
    } catch (err) {
      this.#warnAgg('answer', `${JSON.stringify(result.name)}: ${(err as Error).message}`);
      this.#safeSend(() => {
        const header = this.#responseHeader(result.header, { aa: 0, rcode: RCODE_SERVFAIL });
        send(this.#encodeResponse(header, result.rawQuestion, [], []));
      });
    }
  }

  #responseHeader (wire: WireHeader, over: { aa: number; rcode: number }): ResponseHeader {
    return { id: wire.id, qr: 1, opcode: wire.opcode, aa: over.aa, tc: 0, rd: wire.rd, ra: 0, z: 0, rcode: over.rcode };
  }

  #safeSend (fn: () => void) {
    try { fn(); } catch (err) { this.#warnAgg('send', (err as Error).message); }
  }

  /**
   * Encode a response as header + the raw question bytes (spliced verbatim) +
   * dns2-encoded answers and authorities. The question is echoed byte-for-byte
   * so no re-encoding can alter it; answers are encoded without compression.
   */
  #encodeResponse (header: ResponseHeader, rawQuestion: Buffer, answers: DnsAnswer[], authorities: DnsAnswer[]): Buffer {
    const h = new Packet.Header({
      id: header.id, qr: 1, opcode: header.opcode, aa: header.aa, tc: header.tc,
      rd: header.rd, ra: 0, z: 0, rcode: header.rcode,
      qdcount: 1, ancount: answers.length, nscount: authorities.length, arcount: 0
    });
    const headerBuf: Buffer = h.toBuffer();
    let bodyBuf = Buffer.alloc(0);
    if (answers.length + authorities.length > 0) {
      const writer = new Packet.Writer();
      for (const a of answers) Packet.Resource.encode(a, writer);
      for (const a of authorities) Packet.Resource.encode(a, writer);
      bodyBuf = writer.toBuffer();
    }
    return Buffer.concat([headerBuf, rawQuestion, bodyBuf]);
  }

  /** Encode a header-only reply (qdcount 0): NOTIMP / FORMERR. */
  #encodeHeaderOnly (wire: WireHeader, rcode: number): Buffer {
    const h = new Packet.Header({
      id: wire.id, qr: 1, opcode: wire.opcode, aa: 0, tc: 0,
      rd: wire.rd, ra: 0, z: 0, rcode,
      qdcount: 0, ancount: 0, nscount: 0, arcount: 0
    });
    return h.toBuffer();
  }

  /**
   * Update a runtime DNS entry at runtime (e.g. from admin API / ACME).
   * Persists the record to PlatformDB when the platform exposes `setDnsRecord`,
   * so it survives restart and replicates to other cores.
   * Config-sourced static entries are authoritative and cannot be shadowed —
   * an attempt to update one throws an error. An invalid record is rejected.
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
    const errs = validateDnsRecord(subdomain, records);
    if (errs.length > 0) {
      const msg = `DNS runtime update rejected for '${subdomain}': ${errs[0]}`;
      this.#logger.warn(msg);
      throw new Error(msg);
    }
    if (this.#platform && typeof this.#platform.setDnsRecord === 'function') {
      await this.#platform.setDnsRecord(subdomain, records);
    }
    this.#staticEntries.set(subdomain, records);
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
    this.#staticEntries.delete(subdomain);
    this.#logger.info(`DNS runtime entry deleted: ${subdomain}`);
  }

  /**
   * Build the answer for a conformant in-zone or out-of-zone query. Returns the
   * response header plus answer / authority records (each validated so a stray
   * record is skipped rather than throwing at encode time).
   */
  async #buildAnswer (qnameRaw: string, qtype: number, base: ResponseHeader): Promise<BuiltResponse> {
    const response: BuiltResponse = { header: { ...base }, answers: [], authorities: [] };
    const qname = qnameRaw.toLowerCase();
    const domain = (this.#domain || '').toLowerCase();

    if (!domain || !(qname === domain || qname.endsWith('.' + domain))) {
      // Not a zone we serve: REFUSED, not authoritative, no SOA (answering
      // NXDOMAIN would be a claim about someone else's zone).
      response.header.aa = 0;
      response.header.rcode = RCODE_REFUSED;
      return response;
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
      } else if (this.#isHostedSite(prefix)) {
        // Hosted site (a reserved name serving a folder or a proxy): the
        // cores that advertise it. Ahead of staticEntries, which may not
        // reuse the name (config check), and of the username lookup.
        await this.#answerHostedSite(response, qname, qtype, prefix);
      } else if (this.#staticEntries.has(prefix)) {
        // Static subdomain (www, sw, reg, _acme-challenge, etc.). Operator
        // overrides win over PlatformDB-derived core entries below.
        this.#answerStatic(response, qname, qtype, this.#staticEntries.get(prefix)!);
      } else if (await this.#tryAnswerCoreInfo(response, qname, qtype, prefix)) {
        // Was a `<coreId>.<domain>` query — answered from PlatformDB.
      } else {
        // Assume it's a username — look up the user's core
        await this.#answerUsername(response, qname, qtype, prefix);
      }
    } catch (err: unknown) {
      this.#warnAgg('answer', `${JSON.stringify(qname)}: ${(err as Error).message}`);
      // An internal failure is not a statement that the name does not exist:
      // SERVFAIL is not cached as a negative answer and makes resolvers try
      // the other nameservers (RFC 2308 section 7.1).
      response.answers = [];
      response.header.rcode = RCODE_SERVFAIL;
    }

    // RFC 8482 section 4.1: a QTYPE ANY query is answered with a single RRset
    // rather than every record for the name.
    if (qtype === Packet.TYPE.ANY) this.#reduceToSingleRRset(response);

    // RFC 2308 section 3: NXDOMAIN and NODATA answers carry the zone SOA in
    // the AUTHORITY section so resolvers can cache the negative answer.
    if (response.header.rcode === RCODE_NXDOMAIN ||
        (response.header.rcode === 0 && response.answers.length === 0)) {
      this.#addNegativeSoa(response, domain);
    }

    // Defence in depth: drop any built record whose shape would throw at encode.
    response.answers = this.#keepEncodable(response.answers, 'answer');
    response.authorities = this.#keepEncodable(response.authorities, 'authority');
    return response;
  }

  #keepEncodable (list: DnsAnswer[], label: string): DnsAnswer[] {
    const out: DnsAnswer[] = [];
    for (const a of list) {
      if (isEncodableAnswer(a)) out.push(a);
      else this.#warnAgg('record', `skipped malformed ${label} record for ${JSON.stringify(a.name)}`);
    }
    return out;
  }

  /** Keep only the first RRset (records sharing the first answer's type). */
  #reduceToSingleRRset (response: BuiltResponse) {
    if (response.answers.length <= 1) return;
    const firstType = response.answers[0].type;
    response.answers = response.answers.filter((a) => a.type === firstType);
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
  #addNegativeSoa (response: BuiltResponse, apex: string) {
    const soa = this.#getSoa();
    if (soa == null) return;
    const minimum = Number(soa.minimum);
    const negTtl = Number.isFinite(minimum) ? Math.min(this.#ttl, minimum) : this.#ttl;
    response.authorities.push(buildSOA(apex, soa, negTtl));
  }

  /**
   * Answer root domain queries with configured records.
   */
  #answerRoot (response: BuiltResponse, qname: string, qtype: number) {
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
  async #answerClusterDiscovery (response: BuiltResponse, qname: string, qtype: number) {
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
   * Re-read the hosted-site names advertised in the core-info rows. A failure
   * keeps the previous set (the next refresh retries).
   */
  async #refreshAdvertisedSites () {
    try {
      const names = new Set<string>();
      const coreIds = new Set<string>([this.#coreId]);
      for (const core of await this.#platform.getAllCoreInfos()) {
        if (typeof core.id === 'string') coreIds.add(core.id.toLowerCase());
        if (Array.isArray(core.sites)) {
          for (const name of core.sites) if (typeof name === 'string') names.add(name.toLowerCase());
        }
      }
      this.#advertisedSites = names;
      this.#coreIds = coreIds;
    } catch (err: unknown) {
      this.#logger.warn('DNS hosted-site refresh failed: ' + (err as Error).message);
    }
  }

  #isHostedSite (name: string): boolean {
    // A core's own name always answers with that core (the boot check refuses
    // such a site name; this keeps a misconfigured core from taking it over).
    if (this.#coreIds.has(name)) return false;
    return this.#localSites.has(name) || this.#advertisedSites.has(name);
  }

  /**
   * Answer `<site>.{domain}` with the A / AAAA of every core advertising the
   * site (read fresh). A name configured here that no row advertises yet (this
   * core's registration not replicated) answers with this core's own row.
   */
  async #answerHostedSite (response: BuiltResponse, qname: string, qtype: number, name: string) {
    const cores = await this.#platform.getAllCoreInfos();
    let serving = cores.filter((core) => Array.isArray(core.sites) && core.sites.includes(name));
    if (serving.length === 0 && this.#localSites.has(name)) {
      serving = cores.filter((core) => core.id === this.#coreId);
    }
    const ttl = this.#ttl;
    for (const core of serving) {
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
  #answerStatic (response: BuiltResponse, qname: string, qtype: number, entry: DnsRecordEntry) {
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
  async #answerUsername (response: BuiltResponse, qname: string, qtype: number, username: string) {
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
  async #tryAnswerCoreInfo (response: BuiltResponse, qname: string, qtype: number, prefix: string) {
    const coreInfo = await this.#platform.getCoreInfo(prefix);
    if (coreInfo == null) return false;
    this.#emitCoreInfoRecords(response, qname, qtype, coreInfo);
    return true;
  }

  /**
   * Emit A / AAAA / CNAME from a coreInfo row.
   */
  #emitCoreInfoRecords (response: BuiltResponse, qname: string, qtype: number, coreInfo: CoreInfo) {
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

  /**
   * Record a per-request failure. Failures are coalesced into one warning per
   * window so a flood of bad requests cannot flood the log; the qname in a
   * sample is JSON-escaped by the caller.
   */
  #warnAgg (category: string, detail?: string) {
    this.#warnPending++;
    if (this.#warnSample == null) this.#warnSample = detail ? `${category}: ${detail}` : category;
    if (this.#warnTimer == null) {
      this.#warnTimer = setTimeout(() => this.#flushWarn(), WARN_WINDOW_MS);
      if (typeof this.#warnTimer.unref === 'function') this.#warnTimer.unref();
    }
  }

  #flushWarn () {
    const n = this.#warnPending;
    const sample = this.#warnSample;
    this.#warnPending = 0;
    this.#warnSample = null;
    this.#warnTimer = null;
    if (n > 0) {
      this.#logger.warn(`DNS: ${n} request(s) failed validation or handling in the last ${WARN_WINDOW_MS / 1000}s (sample: ${sample})`);
    }
  }
}

/**
 * Factory function.
 */
function createDnsServer ({ config, platform, logger, platformRefreshIntervalMs, tcpIdleTimeoutMs, tcpMaxConnections }: { config: BoilerConfig; platform: PlatformLike; logger: Logger; platformRefreshIntervalMs?: number; tcpIdleTimeoutMs?: number; tcpMaxConnections?: number }) {
  return new DnsServer({ config, platform, logger, platformRefreshIntervalMs, tcpIdleTimeoutMs, tcpMaxConnections });
}

export { DnsServer, createDnsServer };
