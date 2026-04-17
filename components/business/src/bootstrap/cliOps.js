/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 34 — bootstrap CLI orchestration, decoupled from arg parsing and
 * config loading.
 *
 * `bin/bootstrap.js` is the operator-facing entry point: it parses argv,
 * initialises @pryv/boiler, pulls platform secrets out of the running
 * config, then calls into this module. Everything that talks to the file
 * system, the cluster CA and PlatformDB lives here so it can be unit-tested
 * with a fake PlatformDB and tmp directories — no boiler, no rqlited.
 */

const fs = require('node:fs');
const path = require('node:path');

const ClusterCA = require('./ClusterCA');
const Bundle = require('./Bundle');
const BundleEncryption = require('./BundleEncryption');
const TokenStore = require('./TokenStore');
const DnsRegistration = require('./DnsRegistration');

const ACK_PATH = '/system/admin/cores/ack';

/**
 * Issue a bootstrap bundle for a new core. Pre-registers the core in
 * PlatformDB + DNS, mints a one-time join token, generates a node cert
 * signed by the cluster CA, encrypts everything with a generated passphrase
 * and writes the armored payload to `outPath`.
 *
 * On any failure after PlatformDB writes, rolls back: revokes the token and
 * unregisters the core. Throws the original error.
 *
 * @param {Object} opts
 * @param {Object} opts.platformDB
 * @param {string} opts.caDir
 * @param {string} opts.tokensPath
 * @param {string|null} opts.dnsDomain
 * @param {string} opts.ackUrlBase             - e.g. 'https://core-a.ex.com'
 * @param {Object} opts.secrets
 * @param {string} opts.secrets.adminAccessKey
 * @param {string} opts.secrets.filesReadTokenSecret
 * @param {Object} opts.rqlite
 * @param {number} opts.rqlite.raftPort
 * @param {number} opts.rqlite.httpPort
 * @param {string} opts.coreId
 * @param {string} opts.ip
 * @param {string|null} [opts.url=null]
 * @param {string|null} [opts.hosting=null]
 * @param {string} opts.outPath
 * @param {number} [opts.ttlMs] - token TTL; undefined = TokenStore default (24h)
 * @returns {Promise<{ outPath: string, passphrase: string, expiresAt: number, ackUrl: string, caCreated: boolean }>}
 */
async function newCore (opts) {
  requireOpts(opts, ['platformDB', 'caDir', 'tokensPath', 'ackUrlBase', 'secrets', 'rqlite', 'coreId', 'ip', 'outPath']);
  const {
    platformDB, caDir, tokensPath, dnsDomain = null, ackUrlBase,
    secrets, rqlite, coreId, ip, url = null, hosting = null, outPath, ttlMs
  } = opts;

  // 1. Cluster CA — generate on first call, reuse afterwards.
  const ca = new ClusterCA({ dir: caDir });
  const ensured = ca.ensure();

  // 2. Node cert signed by the cluster CA.
  const hostname = dnsDomain ? `${coreId}.${dnsDomain}` : coreId;
  const { certPem, keyPem } = ca.issueNodeCert({ coreId, ip, hostname });

  // 3. One-time join token. Persisted to tokensPath; raw token only returned
  //    here, never logged.
  const tokenStore = new TokenStore({ path: tokensPath });
  const minted = tokenStore.mint(ttlMs != null ? { coreId, ttlMs } : { coreId });

  // 4. Pre-register in PlatformDB + DNS. Past this point we own rollback.
  let registered = false;
  try {
    await DnsRegistration.registerNewCore({ platformDB, coreId, ip, url, hosting });
    registered = true;

    const ackUrl = ackUrlBase.replace(/\/+$/, '') + ACK_PATH;
    const bundle = Bundle.assemble({
      cluster: {
        domain: dnsDomain || '',
        ackUrl,
        joinToken: minted.token,
        caCertPem: ca.getCACertPem()
      },
      node: { id: coreId, ip, hosting, url, certPem, keyPem },
      platformSecrets: {
        auth: {
          adminAccessKey: secrets.adminAccessKey,
          filesReadTokenSecret: secrets.filesReadTokenSecret
        }
      },
      rqlite: { raftPort: rqlite.raftPort, httpPort: rqlite.httpPort }
    });

    const passphrase = BundleEncryption.generatePassphrase();
    const armored = BundleEncryption.encrypt(bundle, passphrase);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, armored, { mode: 0o600 });

    return {
      outPath,
      passphrase,
      expiresAt: minted.expiresAt,
      ackUrl,
      caCreated: ensured.created
    };
  } catch (err) {
    if (registered) {
      try {
        await DnsRegistration.unregisterNewCore({ platformDB, coreId, ip });
      } catch (_) { /* swallow rollback failure — surface the original error */ }
    }
    try { tokenStore.revokeByCoreId(coreId); } catch (_) { /* same */ }
    throw err;
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.tokensPath
 * @returns {Array<{ coreId: string, issuedAt: number, expiresAt: number }>}
 */
function listTokens ({ tokensPath }) {
  if (!tokensPath) throw new Error('listTokens: tokensPath is required');
  return new TokenStore({ path: tokensPath }).listActive();
}

/**
 * Revoke active tokens for `coreId`. When `platformDB` and `ip` are given,
 * also undoes the DNS + PlatformDB pre-registration.
 *
 * @param {Object} opts
 * @param {string} opts.tokensPath
 * @param {string} opts.coreId
 * @param {Object} [opts.platformDB]
 * @param {string} [opts.ip]
 * @returns {Promise<{ tokensRevoked: number, unregister: Object|null }>}
 */
async function revokeToken ({ tokensPath, coreId, platformDB = null, ip = null }) {
  if (!tokensPath) throw new Error('revokeToken: tokensPath is required');
  if (!coreId) throw new Error('revokeToken: coreId is required');

  const tokensRevoked = new TokenStore({ path: tokensPath }).revokeByCoreId(coreId);

  let unregister = null;
  if (platformDB != null && ip != null) {
    unregister = await DnsRegistration.unregisterNewCore({ platformDB, coreId, ip });
  }
  return { tokensRevoked, unregister };
}

function requireOpts (opts, keys) {
  if (opts == null || typeof opts !== 'object') {
    throw new Error('cliOps: opts is required');
  }
  for (const k of keys) {
    if (opts[k] == null) throw new Error(`cliOps: opts.${k} is required`);
  }
}

module.exports = {
  ACK_PATH,
  newCore,
  listTokens,
  revokeToken
};
