/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 35 Phase 3b — CertRenewer: orchestrates ACME issuance + at-rest
 * encryption + PlatformDB persistence.
 *
 * Glue layer on top of:
 *   - AcmeClient (HTTP to Let's Encrypt)
 *   - AtRestEncryption (encrypts private-key material before it touches
 *     the rqlite-replicated keyValue table)
 *   - PlatformDB.{setAcmeAccount, getAcmeAccount, setCertificate,
 *     getCertificate} (added in Phase 2a)
 *
 * Scheduling (daily check loop, renew-before-N-days logic) is intentionally
 * NOT in this class — that's Phase 4 wiring in bin/master.js. This class
 * exposes the primitive operations; the caller decides when to run them.
 */

const AtRestEncryption = require('./AtRestEncryption');
const AcmeClient = require('./AcmeClient');

const AT_REST_PURPOSE = 'pryv-at-rest-tls-v1';

class CertRenewer {
  #platformDB;
  #atRestKey;
  #email;
  #directoryUrl;
  #acmeLib;

  /**
   * @param {Object} opts
   * @param {Object} opts.platformDB   - needs setAcmeAccount/getAcmeAccount/setCertificate/getCertificate/listCertificates
   * @param {Buffer} opts.atRestKey    - 32-byte symmetric key for encrypting private-key material
   * @param {string} opts.email        - ACME account contact; required to create an account
   * @param {string} [opts.directoryUrl] - default: LE production
   * @param {Object} [opts.acmeLib]    - default: require('acme-client'); injectable for tests
   */
  constructor ({ platformDB, atRestKey, email, directoryUrl, acmeLib } = {}) {
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
   * @returns {Promise<{accountKey: string, accountUrl: string, email: string}|null>}
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
   * @returns {Promise<{accountKey: string, accountUrl: string, email: string}>}
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
   * @param {Object} opts
   * @param {string}   opts.hostname                - e.g. '*.mc.example.com'
   * @param {string[]} [opts.altNames=[]]           - e.g. ['mc.example.com']
   * @param {Object}   opts.dnsWriter               - { create(name, value), remove(name) }; see PlatformDBDnsWriter
   * @param {string[]} [opts.challengePriority]     - default ['dns-01']
   * @returns {Promise<{hostname: string, issuedAt: number, expiresAt: number}>}
   */
  async renew ({ hostname, altNames = [], dnsWriter, challengePriority } = {}) {
    if (!hostname) throw new Error('CertRenewer.renew: hostname is required');
    if (dnsWriter == null || typeof dnsWriter.create !== 'function' || typeof dnsWriter.remove !== 'function') {
      throw new Error('CertRenewer.renew: dnsWriter { create, remove } is required');
    }

    const account = await this.ensureAccount();
    const result = await AcmeClient.issueCert({
      commonName: hostname,
      altNames,
      account,
      challengePriority,
      directoryUrl: this.#directoryUrl,
      challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
        const name = acmeChallengeName(authz.identifier.value);
        await dnsWriter.create(name, keyAuthorization);
      },
      challengeRemoveFn: async (authz, _challenge, keyAuthorization) => {
        const name = acmeChallengeName(authz.identifier.value);
        await dnsWriter.remove(name, keyAuthorization);
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
  }

  /**
   * Retrieve a stored cert with its keyPem decrypted. Other fields
   * (certPem, chainPem) pass through unchanged.
   *
   * @param {string} hostname
   * @returns {Promise<{certPem, chainPem, keyPem, issuedAt, expiresAt}|null>}
   */
  async getCertificate (hostname) {
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
  #platformDB;
  #waitMs;
  constructor ({ platformDB, waitMs = 15000 }) {
    if (platformDB == null) throw new Error('PlatformDBDnsWriter: platformDB is required');
    this.#platformDB = platformDB;
    this.#waitMs = waitMs;
  }

  /**
   * Write a TXT record; append to any existing TXT values for the same
   * name so multiple outstanding challenges can coexist (LE may ask for
   * both the apex and the wildcard in the same order).
   */
  async create (name, value) {
    const existing = await this.#platformDB.getDnsRecord(name);
    const priorTxt = (existing && Array.isArray(existing.txt)) ? existing.txt : [];
    const merged = priorTxt.includes(value) ? priorTxt : [...priorTxt, value];
    await this.#platformDB.setDnsRecord(name, { ...(existing || {}), txt: merged });
    if (this.#waitMs > 0) await new Promise(resolve => setTimeout(resolve, this.#waitMs));
  }

  async remove (name, value) {
    const existing = await this.#platformDB.getDnsRecord(name);
    if (!existing) return;
    const txt = (existing.txt || []).filter(v => v !== value);
    if (txt.length === 0) {
      await this.#platformDB.deleteDnsRecord(name);
    } else {
      await this.#platformDB.setDnsRecord(name, { ...existing, txt });
    }
  }
}

function acmeChallengeName (identifierValue) {
  const host = String(identifierValue).replace(/^\*\./, '');
  return '_acme-challenge.' + host;
}

module.exports = {
  AT_REST_PURPOSE,
  CertRenewer,
  PlatformDBDnsWriter,
  acmeChallengeName
};
