/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 34 — bootstrap bundle schema, assembly and validation.
 *
 * The bundle is the trust boundary between an existing core and a new one:
 * it carries the platform-wide secrets, the new core's identity, the mTLS
 * material and a one-time join token. It is produced by the CLI on the
 * existing core, encrypted with a per-invocation passphrase
 * (see BundleEncryption.js) and consumed on the new core by
 * `bin/master.js --bootstrap`.
 *
 * The schema is versioned. Consumers accept any bundle whose version is in
 * 1..BUNDLE_VERSION (forward-compat is rejected loudly so a downgrade can't
 * silently strip a field). Producers always emit the latest version.
 *
 * v1: original Plan 34 shape.
 * v2: optional `platformSecrets.letsEncrypt.atRestKey` (Plan 54 Phase B) —
 *     base64 32-byte symmetric key used by AtRestEncryption to encrypt cert
 *     + ACME account private keys at rest in rqlite. Issuing core embeds it
 *     when its own config has `letsEncrypt.atRestKey` set; joiner copies it
 *     into override-config.yml so cluster-wide AtRestEncryption keys agree.
 *     Bundle stays v2-shaped even when the field is absent — the field is
 *     optional, the version is not.
 */

const BUNDLE_VERSION = 2;

const REQUIRED_TOP_LEVEL = ['version', 'issuedAt', 'cluster', 'node', 'platformSecrets', 'rqlite'];
const REQUIRED_CLUSTER = ['domain', 'ackUrl', 'joinToken', 'ca'];
const REQUIRED_NODE = ['id', 'certPem', 'keyPem'];
const REQUIRED_PLATFORM_SECRETS = ['auth'];
const REQUIRED_AUTH_SECRETS = ['adminAccessKey', 'filesReadTokenSecret'];
const REQUIRED_RQLITE = ['raftPort', 'httpPort'];

/**
 * Assemble a bundle object from its inputs. Pure — no side effects, no I/O.
 *
 * @param {Object} input
 * @param {Object} input.cluster
 * @param {string} input.cluster.domain - e.g. 'mc.example.com'
 * @param {string} input.cluster.ackUrl - URL of the existing core to ack back to
 * @param {string} input.cluster.joinToken - opaque one-time token (base64 / hex)
 * @param {string} input.cluster.caCertPem - cluster CA cert in PEM form
 * @param {Object} input.node
 * @param {string} input.node.id - core id, e.g. 'core-b'
 * @param {string|null} [input.node.ip=null]
 * @param {string|null} [input.node.hosting=null]
 * @param {string|null} [input.node.url=null] - explicit core.url for DNSless multi-core
 * @param {string} input.node.certPem
 * @param {string} input.node.keyPem
 * @param {Object} input.platformSecrets
 * @param {Object} input.platformSecrets.auth
 * @param {string} input.platformSecrets.auth.adminAccessKey
 * @param {string} input.platformSecrets.auth.filesReadTokenSecret
 * @param {Object} [input.platformSecrets.letsEncrypt]
 * @param {string} [input.platformSecrets.letsEncrypt.atRestKey] - base64 32-byte key; omitted when issuing core has no LE atRestKey set
 * @param {Object} [input.rqlite]
 * @param {number} [input.rqlite.raftPort=4002]
 * @param {number} [input.rqlite.httpPort=4001]
 * @returns {Object} the bundle object, ready to JSON.stringify + encrypt
 */
function assemble (input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Bundle.assemble: input is required');
  }
  requireAll(input, ['cluster', 'node', 'platformSecrets'], 'input');
  requireAll(input.cluster, ['domain', 'ackUrl', 'joinToken', 'caCertPem'], 'cluster');
  requireAll(input.node, ['id', 'certPem', 'keyPem'], 'node');
  requireAll(input.platformSecrets, ['auth'], 'platformSecrets');
  requireAll(input.platformSecrets.auth, ['adminAccessKey', 'filesReadTokenSecret'], 'platformSecrets.auth');

  const rqlite = input.rqlite || {};
  const platformSecrets = {
    auth: {
      adminAccessKey: input.platformSecrets.auth.adminAccessKey,
      filesReadTokenSecret: input.platformSecrets.auth.filesReadTokenSecret
    }
  };
  const atRestKey = input.platformSecrets.letsEncrypt?.atRestKey;
  if (atRestKey != null) {
    platformSecrets.letsEncrypt = { atRestKey };
  }
  return {
    version: BUNDLE_VERSION,
    issuedAt: new Date().toISOString(),
    cluster: {
      domain: input.cluster.domain,
      ackUrl: input.cluster.ackUrl,
      joinToken: input.cluster.joinToken,
      ca: { certPem: input.cluster.caCertPem }
    },
    node: {
      id: input.node.id,
      ip: input.node.ip ?? null,
      hosting: input.node.hosting ?? null,
      url: input.node.url ?? null,
      certPem: input.node.certPem,
      keyPem: input.node.keyPem
    },
    platformSecrets,
    rqlite: {
      raftPort: rqlite.raftPort ?? 4002,
      httpPort: rqlite.httpPort ?? 4001
    }
  };
}

/**
 * Validate a decoded bundle. Called on the new core before any secret is
 * consumed — protects against malformed, tampered or downgraded payloads.
 * Throws descriptive Errors on failure.
 *
 * @param {Object} bundle
 * @returns {Object} the same bundle (for chaining)
 */
function validate (bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Bundle.validate: not an object');
  }
  requireAll(bundle, REQUIRED_TOP_LEVEL, 'bundle');
  if (!Number.isInteger(bundle.version) || bundle.version < 1 || bundle.version > BUNDLE_VERSION) {
    throw new Error(`Bundle.validate: unsupported version ${bundle.version} (this binary understands versions 1..${BUNDLE_VERSION})`);
  }
  requireAll(bundle.cluster, REQUIRED_CLUSTER, 'bundle.cluster');
  if (!bundle.cluster.ca || typeof bundle.cluster.ca.certPem !== 'string' || !bundle.cluster.ca.certPem.includes('BEGIN CERTIFICATE')) {
    throw new Error('Bundle.validate: cluster.ca.certPem must be a PEM certificate');
  }
  if (typeof bundle.cluster.joinToken !== 'string' || bundle.cluster.joinToken.length < 16) {
    throw new Error('Bundle.validate: cluster.joinToken must be a non-trivial string');
  }
  requireAll(bundle.node, REQUIRED_NODE, 'bundle.node');
  if (!bundle.node.certPem.includes('BEGIN CERTIFICATE')) {
    throw new Error('Bundle.validate: node.certPem must be a PEM certificate');
  }
  if (!bundle.node.keyPem.includes('PRIVATE KEY')) {
    throw new Error('Bundle.validate: node.keyPem must be a PEM private key');
  }
  requireAll(bundle.platformSecrets, REQUIRED_PLATFORM_SECRETS, 'bundle.platformSecrets');
  requireAll(bundle.platformSecrets.auth, REQUIRED_AUTH_SECRETS, 'bundle.platformSecrets.auth');
  if (bundle.platformSecrets.letsEncrypt != null) {
    if (typeof bundle.platformSecrets.letsEncrypt !== 'object') {
      throw new Error('Bundle.validate: bundle.platformSecrets.letsEncrypt must be an object');
    }
    if (typeof bundle.platformSecrets.letsEncrypt.atRestKey !== 'string' || bundle.platformSecrets.letsEncrypt.atRestKey.length === 0) {
      throw new Error('Bundle.validate: bundle.platformSecrets.letsEncrypt.atRestKey must be a non-empty string');
    }
  }
  requireAll(bundle.rqlite, REQUIRED_RQLITE, 'bundle.rqlite');
  return bundle;
}

function requireAll (obj, keys, context) {
  if (!obj || typeof obj !== 'object') {
    throw new Error(`Bundle.validate: ${context} is not an object`);
  }
  for (const k of keys) {
    if (obj[k] == null) {
      throw new Error(`Bundle.validate: ${context}.${k} is required`);
    }
  }
}

module.exports = {
  BUNDLE_VERSION,
  assemble,
  validate
};
