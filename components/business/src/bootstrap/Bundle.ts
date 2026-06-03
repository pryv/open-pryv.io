/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Bootstrap bundle schema, assembly and validation.
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
 * v1: original shape.
 * v2: optional `platformSecrets.letsEncrypt.atRestKey` — base64 32-byte
 *     symmetric key used by AtRestEncryption to encrypt cert + ACME account
 *     private keys at rest in rqlite. Issuing core embeds it when its own
 *     config has `letsEncrypt.atRestKey` set; joiner copies it into
 *     override-config.yml so cluster-wide AtRestEncryption keys agree.
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
 * @param input.cluster
 * @param input.cluster.domain - e.g. 'mc.example.com'
 * @param input.cluster.ackUrl - URL of the existing core to ack back to
 * @param input.cluster.joinToken - opaque one-time token (base64 / hex)
 * @param input.cluster.caCertPem - cluster CA cert in PEM form
 * @param input.node
 * @param input.node.id - core id, e.g. 'core-b'
 * @param [input.node.ip=null]
 * @param [input.node.hosting=null]
 * @param [input.node.url=null] - explicit core.url for DNSless multi-core
 * @param input.node.certPem
 * @param input.node.keyPem
 * @param input.platformSecrets
 * @param input.platformSecrets.auth
 * @param input.platformSecrets.auth.adminAccessKey
 * @param input.platformSecrets.auth.filesReadTokenSecret
 * @param [input.platformSecrets.letsEncrypt]
 * @param [input.platformSecrets.letsEncrypt.atRestKey] - base64 32-byte key; omitted when issuing core has no LE atRestKey set
 * @param [input.rqlite]
 * @param [input.rqlite.raftPort=4002]
 * @param [input.rqlite.httpPort=4001]
 */
type AssembleInput = {
  cluster: { domain: string; ackUrl: string; joinToken: string; caCertPem: string };
  node: { id: string; ip?: string | null; hosting?: string | null; url?: string | null; certPem: string; keyPem: string };
  platformSecrets: {
    auth: { adminAccessKey: string; filesReadTokenSecret: string };
    letsEncrypt?: { atRestKey?: string };
  };
  rqlite?: { raftPort?: number; httpPort?: number };
};

type PlatformSecretsAssembled = {
  auth: { adminAccessKey: string; filesReadTokenSecret: string };
  letsEncrypt?: { atRestKey: string };
};

type BundleShape = {
  version: number;
  issuedAt: string;
  cluster: { domain: string; ackUrl: string; joinToken: string; ca: { certPem: string } };
  node: { id: string; ip: string | null; hosting: string | null; url: string | null; certPem: string; keyPem: string };
  platformSecrets: PlatformSecretsAssembled;
  rqlite: { raftPort: number; httpPort: number };
};

function assemble (input: AssembleInput): BundleShape {
  if (!input || typeof input !== 'object') {
    throw new Error('Bundle.assemble: input is required');
  }
  requireAll(input, ['cluster', 'node', 'platformSecrets'], 'input');
  requireAll(input.cluster, ['domain', 'ackUrl', 'joinToken', 'caCertPem'], 'cluster');
  requireAll(input.node, ['id', 'certPem', 'keyPem'], 'node');
  requireAll(input.platformSecrets, ['auth'], 'platformSecrets');
  requireAll(input.platformSecrets.auth, ['adminAccessKey', 'filesReadTokenSecret'], 'platformSecrets.auth');

  const rqlite = input.rqlite || {};
  const platformSecrets: PlatformSecretsAssembled = {
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
 */
function validate (bundleIn: unknown): BundleShape {
  if (!bundleIn || typeof bundleIn !== 'object') {
    throw new Error('Bundle.validate: not an object');
  }
  const bundle = bundleIn as BundleShape;
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

function requireAll (obj: unknown, keys: readonly string[], context: string): void {
  if (!obj || typeof obj !== 'object') {
    throw new Error(`Bundle.validate: ${context} is not an object`);
  }
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (rec[k] == null) {
      throw new Error(`Bundle.validate: ${context}.${k} is required`);
    }
  }
}

export { BUNDLE_VERSION, assemble, validate };