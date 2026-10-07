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
 *   2. Stages the TLS material (CA cert, node cert + key) and an
 *      `override-config.yml` carrying the cluster identity, platform secrets
 *      and rqlite mTLS pointers in a private directory inside `configDir`.
 *   3. On `commit()`, moves them into `tlsDir` / `configDir`; `discard()`
 *      removes them instead.
 *
 * `stageBundle` leaves the decision to the caller: the consumer commits only
 * after the issuing core accepted the ack, so a refused join leaves no
 * secret and no node key on disk. `applyBundle` stages and commits at once.
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
    platform?: { piiHmacKey?: string };
  };
  [k: string]: unknown;
}

interface TlsPaths { caFile: string; certFile: string; keyFile: string }

interface ApplyBundleOpts {
  armoredBundle: string;
  passphrase: string;
  configDir: string;
  tlsDir: string;
  // Default true: a joining core is safe-by-default (non-voter — can't affect
  // quorum). Pass false only to join as a voter for a >=3-core HA cluster.
  asNonVoter?: boolean;
}

const TLS_FILE_NAMES = {
  ca: 'ca.crt',
  cert: 'node.crt',
  key: 'node.key'
};
const OVERRIDE_FILE_NAME = 'override-config.yml';
const STAGING_PREFIX = '.bootstrap-staging-';

interface StagedBundle {
  bundle: BundleShape;
  overridePath: string;
  tlsPaths: TlsPaths;
  stagingDir: string;
  tlsFingerprint: string;
  ackUrl: string;
  joinToken: string;
  coreId: string;
  commit: () => void;
  discard: () => void;
}

/**
 * Decrypt and validate the bundle, then write every file it carries to a
 * private staging directory (`<configDir>/.bootstrap-staging-*`, mode 0700).
 * Nothing reaches `tlsDir` or the live override until `commit()`.
 * Leftover staging directories of an interrupted run are removed first.
 *
 * Returned paths (`overridePath`, `tlsPaths`) are the final locations.
 */
async function stageBundle ({ armoredBundle, passphrase, configDir, tlsDir, asNonVoter = true }: ApplyBundleOpts): Promise<StagedBundle> {
  if (typeof armoredBundle !== 'string' || armoredBundle.length === 0) {
    throw new Error('applyBundle: armoredBundle is required');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('applyBundle: passphrase is required');
  }
  if (!configDir) throw new Error('applyBundle: configDir is required');
  if (!tlsDir) throw new Error('applyBundle: tlsDir is required');

  const bundle = Bundle.validate(BundleEncryption.decrypt(armoredBundle, passphrase));

  const tlsPaths = tlsPathsIn(tlsDir);
  const overridePath = path.join(configDir, OVERRIDE_FILE_NAME);
  const createdDir: string | undefined = fs.mkdirSync(configDir, { recursive: true });
  removeStaleStaging(configDir);
  const stagingDir = fs.mkdtempSync(path.join(configDir, STAGING_PREFIX));
  fs.chmodSync(stagingDir, 0o700);

  const discard = () => {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (createdDir != null) removeEmptyDirs(configDir, createdDir);
  };
  try {
    writeTlsFiles(stagingDir, bundle);
    writeOverrideConfig(stagingDir, bundle, tlsPaths, asNonVoter);
  } catch (err) {
    discard();
    throw err;
  }

  const commit = () => {
    fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    moveFile(path.join(stagingDir, TLS_FILE_NAMES.ca), tlsPaths.caFile);
    moveFile(path.join(stagingDir, TLS_FILE_NAMES.cert), tlsPaths.certFile);
    moveFile(path.join(stagingDir, TLS_FILE_NAMES.key), tlsPaths.keyFile);
    // Last: without the override the core does not use the TLS files.
    moveFile(path.join(stagingDir, OVERRIDE_FILE_NAME), overridePath);
    fs.rmSync(stagingDir, { recursive: true, force: true });
  };

  return {
    bundle,
    overridePath,
    tlsPaths,
    stagingDir,
    tlsFingerprint: sha256Fingerprint(bundle.node.certPem),
    ackUrl: bundle.cluster.ackUrl,
    joinToken: bundle.cluster.joinToken,
    coreId: bundle.node.id,
    commit,
    discard
  };
}

/**
 * Stage and commit at once (no ack in between).
 *
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
async function applyBundle (opts: ApplyBundleOpts) {
  const staged = await stageBundle(opts);
  staged.commit();
  const { commit, discard, stagingDir, ...applied } = staged;
  return applied;
}

function tlsPathsIn (tlsDir: string): TlsPaths {
  return {
    caFile: path.join(tlsDir, TLS_FILE_NAMES.ca),
    certFile: path.join(tlsDir, TLS_FILE_NAMES.cert),
    keyFile: path.join(tlsDir, TLS_FILE_NAMES.key)
  };
}

function writeTlsFiles (dir: string, bundle: BundleShape): void {
  const p = tlsPathsIn(dir);
  fs.writeFileSync(p.caFile, bundle.cluster.ca.certPem, { mode: 0o644 });
  fs.writeFileSync(p.certFile, bundle.node.certPem, { mode: 0o644 });
  fs.writeFileSync(p.keyFile, bundle.node.keyPem, { mode: 0o600 });
}

/** Rename, or copy + rename within the target directory across filesystems. */
function moveFile (from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const tmp = to + '.tmp-' + process.pid;
    fs.copyFileSync(from, tmp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(tmp, fs.statSync(from).mode & 0o777);
    fs.renameSync(tmp, to);
    fs.unlinkSync(from);
  }
}

function removeStaleStaging (configDir: string): void {
  for (const name of fs.readdirSync(configDir)) {
    if (name.startsWith(STAGING_PREFIX)) {
      fs.rmSync(path.join(configDir, name), { recursive: true, force: true });
    }
  }
}

/** Remove `dir` and its parents up to `top` (the first directory created), while empty. */
function removeEmptyDirs (dir: string, top: string): void {
  let current = path.resolve(dir);
  const stop = path.resolve(top);
  while (current.startsWith(stop)) {
    try { fs.rmdirSync(current); } catch { return; }
    if (current === stop) return;
    current = path.dirname(current);
  }
}

function writeOverrideConfig (dir: string, bundle: BundleShape, tlsPaths: TlsPaths, asNonVoter: boolean = true): string {
  const overridePath = path.join(dir, OVERRIDE_FILE_NAME);

  const override: Record<string, unknown> = {
    core: pruneNull({
      id: bundle.node.id,
      url: bundle.node.url,
      ip: bundle.node.ip,
      hosting: bundle.node.hosting,
      // Joining cores default to non-voter (safe by default): replicate the
      // platform DB + forward writes to the leader, but never count toward Raft
      // quorum, so an unreachable joiner can't stall the cluster. Joining as a
      // voter (asNonVoter=false, --bootstrap-as-voter) is the deliberate choice
      // for a >=3-core HA cluster.
      nonVoter: asNonVoter ? true : undefined
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
  // `certRenewer: false` is stamped explicitly: the issuing core is the
  // cluster's ACME renewer, so a joiner is a materialize-only follower —
  // deriveHostnames uses the explicit false to keep it watching the
  // cluster wildcard instead of its auto-derived per-core hostname.
  if (bundle.platformSecrets?.letsEncrypt?.atRestKey) {
    override.letsEncrypt = {
      atRestKey: bundle.platformSecrets.letsEncrypt.atRestKey,
      certRenewer: false
    };
  }

  // Bundle v3: propagate platform.piiHmacKey when issuer shipped one. Joiner
  // ends up with the same HMAC pepper as the rest of the cluster, so equality
  // lookups on hashed PlatformDB columns resolve consistently regardless of
  // which core wrote the row.
  if (bundle.platformSecrets?.platform?.piiHmacKey) {
    override.platform = { piiHmacKey: bundle.platformSecrets.platform.piiHmacKey };
  }

  const header =
    '# Generated by `bin/master.js --bootstrap` on ' + new Date().toISOString() + '.\n' +
    '# Do not edit by hand — re-running --bootstrap overwrites this file.\n' +
    '# It holds platform secrets: keep it readable by the service user only.\n' +
    '# This file is the highest-precedence config layer: its values win over\n' +
    '# --config files and env vars, so settings it carries cannot be\n' +
    '# overridden elsewhere.\n\n';
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

export { TLS_FILE_NAMES, STAGING_PREFIX, applyBundle, stageBundle, sha256Fingerprint };