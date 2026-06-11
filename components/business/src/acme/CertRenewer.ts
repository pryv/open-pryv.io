/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * CertRenewer: orchestrates ACME issuance + at-rest encryption + PlatformDB
 * persistence.
 *
 * Glue layer on top of:
 *   - AcmeClient (HTTP to Let's Encrypt)
 *   - AtRestEncryption (encrypts private-key material before it touches
 *     the rqlite-replicated keyValue table)
 *   - PlatformDB.{setAcmeAccount, getAcmeAccount, setCertificate,
 *     getCertificate}
 *
 * Scheduling (daily check loop, renew-before-N-days logic) is intentionally
 * NOT in this class — that's wired in bin/master.js. This class exposes the
 * primitive operations; the caller decides when to run them.
 */

const AtRestEncryption = require('./AtRestEncryption.ts');
const AcmeClient = require('./AcmeClient.ts');
const observability = require('../observability/index.ts');

const AT_REST_PURPOSE = 'pryv-at-rest-tls-v1';

type PlatformDB = {
  getAcmeAccount (): Promise<{ accountKey: Buffer; accountUrl: string; email: string } | null>;
  setAcmeAccount (acc: { accountKey: Buffer; accountUrl: string; email: string }): Promise<unknown>;
  getCertificate (hostname: string): Promise<{ certPem: string; chainPem?: string; keyPem: Buffer; issuedAt: number; expiresAt: number } | null>;
  setCertificate (hostname: string, cert: { certPem: string; chainPem?: string; keyPem: Buffer; issuedAt: number; expiresAt: number }): Promise<unknown>;
  listCertificates? (): Promise<unknown[]>;
  getDnsRecord (name: string): Promise<{ txt?: string[]; [k: string]: unknown } | null>;
  setDnsRecord (name: string, record: Record<string, unknown>): Promise<unknown>;
  deleteDnsRecord (name: string): Promise<unknown>;
};
type DnsServerLike = { refreshFromPlatform?: () => Promise<unknown> };
type DnsWriter = { create (name: string, value: string): Promise<unknown>; remove (name: string, value: string): Promise<unknown> };
type Account = { accountKey: string; accountUrl: string; email: string };
type AcmeAuthz = { identifier: { value: string } };
type AcmeChallenge = { type: string; token: string; [k: string]: unknown };

class CertRenewer {
  #platformDB: PlatformDB;
  #atRestKey: Buffer;
  #email: string;
  #directoryUrl: string;
  #acmeLib: unknown;

  /**
   * @param opts.platformDB   - needs setAcmeAccount/getAcmeAccount/setCertificate/getCertificate/listCertificates
   * @param opts.atRestKey    - 32-byte symmetric key for encrypting private-key material
   * @param opts.email        - ACME account contact; required to create an account
   * @param [opts.directoryUrl] - default: LE production
   * @param [opts.acmeLib]    - default: require('acme-client'); injectable for tests
   */
  constructor ({ platformDB, atRestKey, email, directoryUrl, acmeLib }: { platformDB?: PlatformDB; atRestKey?: Buffer; email?: string; directoryUrl?: string; acmeLib?: unknown } = {}) {
    if (platformDB == null) throw new Error('CertRenewer: platformDB is required');
    if (!Buffer.isBuffer(atRestKey) || atRestKey.length !== 32) {
      throw new Error('CertRenewer: atRestKey must be a 32-byte Buffer');
    }
    if (!email) throw new Error('CertRenewer: email is required');
    this.#platformDB = platformDB;
    this.#atRestKey = atRestKey;
    this.#email = email;
    this.#directoryUrl = directoryUrl || AcmeClient.DIRECTORY_PRODUCTION;
    this.#acmeLib = acmeLib;
  }

  /**
   * Retrieve the stored ACME account (decrypted) or null. Used mostly by
   * admin surfaces and by ensureAccount() itself.
   *
   */
  async getAccount () {
    const stored = await this.#platformDB.getAcmeAccount();
    if (!stored) return null;
    return {
      accountKey: AtRestEncryption.decrypt(stored.accountKey, this.#atRestKey).toString('utf8'),
      accountUrl: stored.accountUrl,
      email: stored.email
    };
  }

  /**
   * Idempotent: returns an ACME account, creating a fresh one the first
   * time this is called. The account key is encrypted at rest before
   * being handed to PlatformDB.
   *
   */
  async ensureAccount () {
    const existing = await this.getAccount();
    if (existing) return existing;

    const fresh = await AcmeClient.createAccount({
      email: this.#email,
      directoryUrl: this.#directoryUrl,
      acmeLib: this.#acmeLib
    });
    await this.#platformDB.setAcmeAccount({
      accountKey: AtRestEncryption.encrypt(fresh.accountKey, this.#atRestKey),
      accountUrl: fresh.accountUrl,
      email: fresh.email
    });
    return {
      accountKey: fresh.accountKey,
      accountUrl: fresh.accountUrl,
      email: fresh.email
    };
  }

  /**
   * Issue (or renew — ACME makes no distinction) a cert and persist it.
   * The keyPem is encrypted at rest before being handed to PlatformDB;
   * the public certPem + chainPem are stored as-is.
   *
   * @param opts.hostname                - e.g. '*.mc.example.com'
   * @param [opts.altNames=[]]           - e.g. ['mc.example.com']
   * @param [opts.dnsWriter]             - { create(name, value), remove(name) }; see PlatformDBDnsWriter. Required for DNS-01.
   * @param [opts.http01Store]           - Http01ChallengeStore (set/delete). Required for HTTP-01.
   * @param [opts.challengePriority]     - default ['dns-01']
   */
  async renew ({ hostname, altNames = [], dnsWriter, http01Store, challengePriority }: { hostname?: string; altNames?: string[]; dnsWriter?: DnsWriter; http01Store?: { set: (token: string, ka: string) => void; delete: (token: string) => void }; challengePriority?: string[] } = {}) {
    if (!hostname) throw new Error('CertRenewer.renew: hostname is required');
    // We need ONE of dnsWriter or http01Store, depending on what
    // challengePriority asks for. We can't tell which the ACME server
    // will actually offer up front, so require both consumers to be
    // structurally sane if they're passed in.
    const hasDns = dnsWriter != null && typeof dnsWriter.create === 'function' && typeof dnsWriter.remove === 'function';
    const hasHttp = http01Store != null && typeof http01Store.set === 'function' && typeof http01Store.delete === 'function';
    if (!hasDns && !hasHttp) {
      throw new Error('CertRenewer.renew: at least one of dnsWriter / http01Store is required');
    }

    // Wrap as a named background transaction so LE issuance + renewal
    // rollups show up in APM even without Express-triggered traffic.
    // No-op when no observability provider is attached.
    return await observability.startBackgroundTransaction('letsencrypt.renew', async () => {
      try {
        const account = await this.ensureAccount();
        const result = await AcmeClient.issueCert({
          commonName: hostname,
          altNames,
          account,
          challengePriority,
          directoryUrl: this.#directoryUrl,
          challengeCreateFn: async (authz: AcmeAuthz, challenge: AcmeChallenge, keyAuthorization: string) => {
            const type = (challenge && challenge.type) || 'dns-01';
            if (type === 'dns-01') {
              if (!hasDns) throw new Error('CertRenewer.renew: dns-01 challenge but no dnsWriter provided');
              const name = acmeChallengeName(authz.identifier.value);
              await dnsWriter!.create(name, keyAuthorization);
            } else if (type === 'http-01') {
              if (!hasHttp) throw new Error('CertRenewer.renew: http-01 challenge but no http01Store provided');
              http01Store!.set(challenge.token, keyAuthorization);
            } else {
              throw new Error(`CertRenewer.renew: unsupported challenge type "${type}"`);
            }
          },
          challengeRemoveFn: async (authz: AcmeAuthz, challenge: AcmeChallenge, keyAuthorization: string) => {
            const type = (challenge && challenge.type) || 'dns-01';
            if (type === 'dns-01') {
              if (!hasDns) return;
              const name = acmeChallengeName(authz.identifier.value);
              await dnsWriter!.remove(name, keyAuthorization);
            } else if (type === 'http-01') {
              if (!hasHttp) return;
              http01Store!.delete(challenge.token);
            }
          },
          acmeLib: this.#acmeLib
        });

        await this.#platformDB.setCertificate(hostname, {
          certPem: result.certPem,
          chainPem: result.chainPem,
          keyPem: AtRestEncryption.encrypt(result.keyPem, this.#atRestKey),
          issuedAt: result.issuedAt,
          expiresAt: result.expiresAt
        });
        return {
          hostname,
          issuedAt: result.issuedAt,
          expiresAt: result.expiresAt
        };
      } catch (err) {
        observability.recordError(err, { hostname, context: 'letsencrypt.renew' });
        throw err;
      }
    });
  }

  /**
   * Retrieve a stored cert with its keyPem decrypted. Other fields
   * (certPem, chainPem) pass through unchanged.
   *
   */
  async getCertificate (hostname: string) {
    const stored = await this.#platformDB.getCertificate(hostname);
    if (!stored) return null;
    return {
      certPem: stored.certPem,
      chainPem: stored.chainPem,
      keyPem: AtRestEncryption.decrypt(stored.keyPem, this.#atRestKey).toString('utf8'),
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt
    };
  }
}

/**
 * Minimal DNS writer backed by PlatformDB's setDnsRecord / deleteDnsRecord
 * (multi-core with embedded DNS). After setDnsRecord, waits `waitMs` for
 * the record to propagate to LE's geo-distributed resolvers; measured
 * need during the Phase 1 spike was ~15s.
 */
class PlatformDBDnsWriter {
  #platformDB: PlatformDB;
  #dnsServer: DnsServerLike | null;
  #waitMs: number;
  constructor ({ platformDB, dnsServer = null, waitMs = 30000 }: { platformDB?: PlatformDB; dnsServer?: DnsServerLike | null; waitMs?: number }) {
    if (platformDB == null) throw new Error('PlatformDBDnsWriter: platformDB is required');
    this.#platformDB = platformDB;
    this.#dnsServer = dnsServer;
    this.#waitMs = waitMs;
  }

  /**
   * Write a TXT record; append to any existing TXT values for the same
   * name so multiple outstanding challenges can coexist (LE may ask for
   * both the apex and the wildcard in the same order).
   *
   * If a `dnsServer` was provided, force a refresh from PlatformDB right
   * after the write so the record is visible in the in-memory zone before
   * we notify LE to validate — without it, the record is only visible
   * after the next periodic refresh (default 30s), often causing LE to
   * time out on "No TXT records found". Surfaced on
   */
  async create (name: string, value: string) {
    const existing = await this.#platformDB.getDnsRecord(name);
    const priorTxt = (existing && Array.isArray(existing.txt)) ? existing.txt : [];
    const merged = priorTxt.includes(value) ? priorTxt : [...priorTxt, value];
    await this.#platformDB.setDnsRecord(name, { ...(existing || {}), txt: merged });
    if (this.#dnsServer && typeof this.#dnsServer.refreshFromPlatform === 'function') {
      await this.#dnsServer.refreshFromPlatform();
    }
    if (this.#waitMs > 0) await new Promise(resolve => setTimeout(resolve, this.#waitMs));
  }

  async remove (name: string, value: string) {
    const existing = await this.#platformDB.getDnsRecord(name);
    if (!existing) return;
    const txt = (existing.txt || []).filter((v: string) => v !== value);
    if (txt.length === 0) {
      await this.#platformDB.deleteDnsRecord(name);
    } else {
      await this.#platformDB.setDnsRecord(name, { ...existing, txt });
    }
    if (this.#dnsServer && typeof this.#dnsServer.refreshFromPlatform === 'function') {
      await this.#dnsServer.refreshFromPlatform();
    }
  }
}

/**
 * Short-form subdomain key for the _acme-challenge TXT record.
 *
 * The full record's FQDN is `_acme-challenge.{zone}` — but our
 * embedded DNS server (components/dns-server/src/DnsServer.js) matches
 * on the short form relative to `dns.domain`: it extracts
 * `prefix = qname.slice(0, -(dns.domain.length + 1))` and looks up
 * `this.#staticEntries[prefix]`. So for a cert covering
 * `*.example.com + example.com` with `dns.domain: example.com`, the
 * PlatformDB key is just `_acme-challenge` — any other shape silently
 * fails to resolve during LE validation.
 *
 * This function used to return the FQDN shape; a pre-prod rollout
 * surfaced the mismatch with DnsServer.
 *
 * @param identifierValue - LE authz identifier (e.g. `*.example.com`)
 */
// identifierValue is ignored today — LE's DNS-01 spec says all challenges
// for a multi-SAN cert land at the same `_acme-challenge.{zone}` TXT
// record, with multiple values. Argument kept for API stability + future
// multi-zone extensions.

function acmeChallengeName (_identifierValue: string): string {
  return '_acme-challenge';
}

export { AT_REST_PURPOSE, CertRenewer, PlatformDBDnsWriter, acmeChallengeName };