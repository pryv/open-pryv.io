/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Apply a bootstrap bundle on the new core.
 *
 * Given the armored bundle file content + the passphrase, this module:
 *   1. Decrypts and schema-validates the bundle.
 *   2. Writes the TLS material (CA cert, node cert + key) to `tlsDir`.
 *   3. Writes an `override-config.yml` to `configDir` carrying the cluster
 *      identity, platform secrets and rqlite mTLS pointers.
 *
 * The new core's master process picks the override file up automatically:
 * @pryv/boiler always loads `override-config.yml` from `baseConfigDir` at
 * the highest precedence (see node_modules/@pryv/boiler/src/config.js).
 *
 * Pure-ish: no network, no boiler, no PlatformDB. The caller (master.js's
 * --bootstrap branch) drives the ack POST separately.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

const Bundle = require('./Bundle.ts');
const BundleEncryption = require('./BundleEncryption.ts');

interface BundleShape {
  node: { id: string; url: string; ip?: string; hosting?: string; certPem: string; keyPem: string };
  cluster: { ca: { certPem: string }; ackUrl: string; joinToken: string; domain?: string };
  rqlite: { raftPort: number; httpPort: number };
  platformSecrets: {
    auth: { adminAccessKey: string; filesReadTokenSecret: string };
    letsEncrypt?: { atRestKey?: string };
  };
  [k: string]: unknown;
}

interface TlsPaths { caFile: string; certFile: string; keyFile: string }

interface ApplyBundleOpts {
  armoredBundle: string;
  passphrase: string;
  configDir: string;
  tlsDir: string;
}

const TLS_FILE_NAMES = {
  ca: 'ca.crt',
  cert: 'node.crt',
  key: 'node.key'
};

/**
 * @param opts.armoredBundle - armored ciphertext (output of bin/bootstrap.js)
 * @param opts.passphrase
 * @param opts.configDir - directory to write override-config.yml into (e.g. baseConfigDir)
 * @param opts.tlsDir    - directory for ca.crt / node.crt / node.key (created if absent)
 *   bundle: Object,
 *   overridePath: string,
 *   tlsPaths: { caFile: string, certFile: string, keyFile: string },
 *   tlsFingerprint: string,
 *   ackUrl: string,
 *   joinToken: string,
 *   coreId: string
 * }>}
 */
async function applyBundle ({ armoredBundle, passphrase, configDir, tlsDir }: ApplyBundleOpts) {
  if (typeof armoredBundle !== 'string' || armoredBundle.length === 0) {
    throw new Error('applyBundle: armoredBundle is required');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('applyBundle: passphrase is required');
  }
  if (!configDir) throw new Error('applyBundle: configDir is required');
  if (!tlsDir) throw new Error('applyBundle: tlsDir is required');

  const bundle = Bundle.validate(BundleEncryption.decrypt(armoredBundle, passphrase));

  const tlsPaths = writeTlsFiles(tlsDir, bundle);
  const tlsFingerprint = sha256Fingerprint(bundle.node.certPem);

  const overridePath = writeOverrideConfig(configDir, bundle, tlsPaths);

  return {
    bundle,
    overridePath,
    tlsPaths,
    tlsFingerprint,
    ackUrl: bundle.cluster.ackUrl,
    joinToken: bundle.cluster.joinToken,
    coreId: bundle.node.id
  };
}

function writeTlsFiles (tlsDir: string, bundle: BundleShape): TlsPaths {
  fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const caFile = path.join(tlsDir, TLS_FILE_NAMES.ca);
  const certFile = path.join(tlsDir, TLS_FILE_NAMES.cert);
  const keyFile = path.join(tlsDir, TLS_FILE_NAMES.key);
  fs.writeFileSync(caFile, bundle.cluster.ca.certPem, { mode: 0o644 });
  fs.writeFileSync(certFile, bundle.node.certPem, { mode: 0o644 });
  fs.writeFileSync(keyFile, bundle.node.keyPem, { mode: 0o600 });
  return { caFile, certFile, keyFile };
}

function writeOverrideConfig (configDir: string, bundle: BundleShape, tlsPaths: TlsPaths): string {
  fs.mkdirSync(configDir, { recursive: true });
  const overridePath = path.join(configDir, 'override-config.yml');

  const override: Record<string, unknown> = {
    core: pruneNull({
      id: bundle.node.id,
      url: bundle.node.url,
      ip: bundle.node.ip,
      hosting: bundle.node.hosting
    }),
    auth: {
      adminAccessKey: bundle.platformSecrets.auth.adminAccessKey,
      filesReadTokenSecret: bundle.platformSecrets.auth.filesReadTokenSecret
    },
    storages: {
      engines: {
        rqlite: {
          raftPort: bundle.rqlite.raftPort,
          url: `http://localhost:${bundle.rqlite.httpPort}`,
          tls: {
            caFile: tlsPaths.caFile,
            certFile: tlsPaths.certFile,
            keyFile: tlsPaths.keyFile,
            verifyClient: true
          }
        }
      }
    }
  };

  // dns.domain + dnsLess off only when bundle ships a domain (DNS-based
  // multi-core). DNSless multi-core skips both — peers find each other via
  // explicit core.url instead.
  if (bundle.cluster.domain) {
    override.dns = { domain: bundle.cluster.domain };
    override.dnsLess = { isActive: false };
    // Multi-core via DNS: opt rqlited into peer discovery via lsc.<domain>.
    // Single-core deploys (no bundle, no override) keep the default `false`.
    override.cluster = { discoveryEnabled: true };
  }

  // Bundle v2: propagate letsEncrypt.atRestKey when issuer shipped one. Joiner
  // ends up with the same AES-GCM key as the rest of the cluster, so cert +
  // ACME account rows in rqlite can be decrypted on either side.
  if (bundle.platformSecrets?.letsEncrypt?.atRestKey) {
    override.letsEncrypt = { atRestKey: bundle.platformSecrets.letsEncrypt.atRestKey };
  }

  const header =
    '# Generated by `bin/master.js --bootstrap` on ' + new Date().toISOString() + '.\n' +
    '# Do not edit by hand — re-running --bootstrap overwrites this file.\n' +
    '# To customize beyond what the bundle ships, layer additional config\n' +
    '# files via --config or env vars; @pryv/boiler merges them on top.\n\n';
  fs.writeFileSync(overridePath, header + yaml.dump(override, { lineWidth: 200 }), { mode: 0o600 });
  return overridePath;
}

function pruneNull (obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null) out[k] = v;
  }
  return out;
}

function sha256Fingerprint (pem: string): string {
  // Match the canonical OpenSSL "SHA256 Fingerprint=AA:BB:..." format.
  const der = pemToDer(pem);
  const hex = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  return hex.match(/.{2}/g)!.join(':');
}

function pemToDer (pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

export { TLS_FILE_NAMES, applyBundle, sha256Fingerprint };