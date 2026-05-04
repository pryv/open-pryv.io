/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


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
const yaml = require('js-yaml');

const ClusterCA = require('./ClusterCA');
const Bundle = require('./Bundle');
const BundleEncryption = require('./BundleEncryption');
const TokenStore = require('./TokenStore');
const DnsRegistration = require('./DnsRegistration');

const ACK_PATH = '/system/admin/cores/ack';
const TLS_FILE_NAMES = { ca: 'ca.crt', cert: 'node.crt', key: 'node.key' };
const OVERRIDE_HEADER_PREFIX =
  '# Generated/updated by `bin/bootstrap.js init-ca-holder` on ';
const OVERRIDE_HEADER_SUFFIX =
  '.\n# Other keys (if any) are preserved across re-runs.\n\n';

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
 * @param {string|null} [opts.secrets.letsEncryptAtRestKey=null] - propagated to bundle.platformSecrets.letsEncrypt.atRestKey when set
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
    const platformSecrets: any = {
      auth: {
        adminAccessKey: secrets.adminAccessKey,
        filesReadTokenSecret: secrets.filesReadTokenSecret
      }
    };
    if (secrets.letsEncryptAtRestKey != null) {
      platformSecrets.letsEncrypt = { atRestKey: secrets.letsEncryptAtRestKey };
    }
    const bundle = Bundle.assemble({
      cluster: {
        domain: dnsDomain || '',
        ackUrl,
        joinToken: minted.token,
        caCertPem: ca.getCACertPem()
      },
      node: { id: coreId, ip, hosting, url, certPem, keyPem },
      platformSecrets,
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

/**
 * Plan 54 Phase C — initialise the CA-holder core's own TLS material so it
 * can serve mTLS to joining cores' rqlited peers.
 *
 * Idempotent. On first invocation: ensures the cluster CA, mints a node cert
 * for `coreId`, writes ca.crt/node.crt/node.key into `tlsDir`, and (when
 * `writeConfig` is true) merges an `storages.engines.rqlite.tls.*` block
 * into `overridePath`. On re-run: detects the existing artefacts and exits
 * cleanly.
 *
 * Symmetric with `applyBundle`: the joiner's TLS layout is `<tlsDir>/{ca,
 * node}.{crt,key}` with the same modes (ca 0644, cert 0644, key 0600). The
 * `verifyClient: true` flag is set on both ends — that is the invariant the
 * Plan 36 manual workaround was about.
 *
 * @param {Object} opts
 * @param {string} opts.caDir - cluster CA dir (`ClusterCA` ensures this).
 * @param {string} opts.tlsDir - where ca.crt / node.crt / node.key go.
 * @param {string} opts.coreId - this core's identifier.
 * @param {string|null} [opts.ip=null] - IP SAN for the node cert (for direct-IP peers).
 * @param {string|null} [opts.hostname=null] - extra DNS SAN (e.g. `<id>.<domain>`).
 * @param {boolean} [opts.writeConfig=true] - merge `rqlite.tls.*` into overridePath.
 * @param {string|null} [opts.overridePath=null] - path to override-config.yml; required when writeConfig is true.
 * @returns {Promise<{
 *   caCreated: boolean,
 *   tlsCreated: boolean,
 *   configUpdated: boolean,
 *   tlsPaths: { caFile: string, certFile: string, keyFile: string }
 * }>}
 */
async function initCaHolder (opts) {
  requireOpts(opts, ['caDir', 'tlsDir', 'coreId']);
  const {
    caDir, tlsDir, coreId,
    ip = null, hostname = null,
    writeConfig = true, overridePath = null
  } = opts;
  if (writeConfig && !overridePath) {
    throw new Error('initCaHolder: overridePath is required when writeConfig is true');
  }

  const ca = new ClusterCA({ dir: caDir });
  const ensured = ca.ensure();

  const caFile = path.join(tlsDir, TLS_FILE_NAMES.ca);
  const certFile = path.join(tlsDir, TLS_FILE_NAMES.cert);
  const keyFile = path.join(tlsDir, TLS_FILE_NAMES.key);
  const tlsPaths = { caFile, certFile, keyFile };

  // Idempotency: if all three files exist, treat the TLS half as already done.
  const tlsAlreadyPresent = fs.existsSync(caFile) && fs.existsSync(certFile) && fs.existsSync(keyFile);
  let tlsCreated = false;
  if (!tlsAlreadyPresent) {
    fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    const { certPem, keyPem } = ca.issueNodeCert({ coreId, ip, hostname });
    fs.writeFileSync(caFile, ca.getCACertPem(), { mode: 0o644 });
    fs.writeFileSync(certFile, certPem, { mode: 0o644 });
    fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
    tlsCreated = true;
  }

  let configUpdated = false;
  if (writeConfig) {
    configUpdated = mergeRqliteTlsIntoOverride(overridePath, tlsPaths);
  }

  return {
    caCreated: ensured.created,
    tlsCreated,
    configUpdated,
    tlsPaths
  };
}

/**
 * Read-modify-write `overridePath`, merging `storages.engines.rqlite.tls.*`
 * with the supplied paths and `verifyClient: true`. Preserves any existing
 * keys. Returns true when the file was created or its contents changed.
 */
function mergeRqliteTlsIntoOverride (overridePath, tlsPaths) {
  let current: any = {};
  if (fs.existsSync(overridePath)) {
    const raw = fs.readFileSync(overridePath, 'utf8');
    const parsed = yaml.load(raw);
    if (parsed != null && typeof parsed === 'object') current = parsed;
  } else {
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  }

  const desired = {
    caFile: tlsPaths.caFile,
    certFile: tlsPaths.certFile,
    keyFile: tlsPaths.keyFile,
    verifyClient: true
  };

  current.storages ??= {};
  current.storages.engines ??= {};
  current.storages.engines.rqlite ??= {};
  const existing = current.storages.engines.rqlite.tls;
  const alreadyMatches = existing != null &&
    existing.caFile === desired.caFile &&
    existing.certFile === desired.certFile &&
    existing.keyFile === desired.keyFile &&
    existing.verifyClient === true;
  if (alreadyMatches) return false;

  current.storages.engines.rqlite.tls = Object.assign({}, existing, desired);
  const header = OVERRIDE_HEADER_PREFIX + new Date().toISOString() + OVERRIDE_HEADER_SUFFIX;
  fs.writeFileSync(
    overridePath,
    header + yaml.dump(current, { lineWidth: 200 }),
    { mode: 0o600 }
  );
  return true;
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
  TLS_FILE_NAMES,
  newCore,
  listTokens,
  revokeToken,
  initCaHolder
};
