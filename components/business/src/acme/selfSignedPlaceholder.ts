/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { ConfigLike } from '@pryv/boiler';
const require = createRequire(import.meta.url);
/**
 * Pre-fork placeholder cert for the LE first-boot race.
 *
 * Master forks api-server workers in the same tick as it kicks off the
 * ACME orchestrator. Workers' `https.createServer(buildHttpsOptions(config))`
 * does `fs.readFileSync(http.ssl.keyFile)` synchronously and ENOENTs before
 * ACME has had time to issue the initial cert — the worker crashes and the
 * cluster restart-loops until ACME gives up.
 *
 * Fix: when `letsEncrypt.enabled` and the configured cert files are absent,
 * write a 1-day self-signed cert at the expected paths before forking. ACME
 * issues the real cert later; FileMaterializer writes it to the same paths,
 * the master broadcasts an `acme:rotate` IPC message, and each worker calls
 * `reloadTls()` → `https.Server.setSecureContext()` to hot-swap. The
 * placeholder is only ever served during the brief window before the first
 * ACME order completes — typically seconds for HTTP-01, minutes for DNS-01.
 *
 * Pure node:crypto + node-forge (already a transitive of acme-client). No
 * shell-out to openssl, no extra dep.
 */

const fs = require('node:fs');
const path = require('node:path');
const forge = require('node-forge');

type EnsureOpts = {
  config?: ConfigLike;
  deriveHostnames?: (config: ConfigLike) => { commonName: string; altNames?: string[] };
  log?: (msg: string) => void;
};

/**
 * Generate a 1-day self-signed RSA-2048 cert valid for `commonName` and
 * `altNames`. Returns { keyPem, certPem }.
 */
function generate ({ commonName, altNames = [] }: { commonName: string; altNames?: string[] }) {
  if (typeof commonName !== 'string' || commonName.length === 0) {
    throw new Error('selfSignedPlaceholder.generate: commonName is required');
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Random serial so successive boots don't collide if a client cached one.
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(cert.validity.notBefore.getTime() + 24 * 60 * 60 * 1000);

  // CN matches what the eventual ACME cert will carry — so a client that
  // does happen to connect during the placeholder window sees the right
  // hostname (still untrusted, but at least the SAN is correct).
  const subject = [{ name: 'commonName', value: commonName }];
  cert.setSubject(subject);
  cert.setIssuer(subject);

  // SAN = commonName + altNames. For wildcard CNs, add the apex too if it
  // isn't already in altNames.
  const sanNames = new Set([commonName, ...altNames]);
  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true
    },
    {
      name: 'subjectAltName',
      altNames: Array.from(sanNames).map(name => ({ type: 2, value: name })) // type 2 = DNS
    }
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert)
  };
}

/**
 * If `letsEncrypt.enabled` and the configured `http.ssl.keyFile` is absent,
 * materialize a 1-day self-signed cert at the configured paths so workers
 * can boot HTTPS without ENOENT. No-op when LE is off, when the paths are
 * not configured, or when the files already exist (e.g. cluster has already
 * been issued a cert and we're restarting).
 *
 * @param opts.config        - @pryv/boiler config
 * @param [opts.deriveHostnames] - injectable for tests; defaults to ../deriveHostnames
 * @param [opts.log]       - logger
 */
function ensure ({ config, deriveHostnames: deriveHostnamesFn, log = (_: string) => {} }: EnsureOpts = {}) {
  if (config == null) throw new Error('selfSignedPlaceholder.ensure: config is required');
  if (!config.get('letsEncrypt:enabled')) {
    return { written: false, reason: 'letsEncrypt-disabled' };
  }
  const keyFile = config.get('http:ssl:keyFile') as string | undefined;
  const certFile = config.get('http:ssl:certFile') as string | undefined;
  if (!keyFile || !certFile) {
    return { written: false, reason: 'ssl-paths-not-configured' };
  }
  const derive = deriveHostnamesFn || require('./deriveHostnames.ts').deriveHostnames;
  const { commonName, altNames } = derive(config);

  // Restore branch: check the materialized layout FIRST, before any
  // existence check on the configured ssl paths. The bug we're closing
  // (B-2026-06-03 RC.1 blocker): on every container restart, the
  // worker-config paths (`http.ssl.*`) may still hold a stale placeholder
  // from a previous boot's selfSignedPlaceholder.ensure() (which was
  // never overwritten by the in-memory hot-swap — that only mutates
  // SecureContext, not on-disk files). If the FileMaterializer has a
  // real LE cert at `<tlsDir>/<hostnameDir>/{fullchain,privkey}.pem`,
  // copy it over the worker paths so workers fork up with the real
  // cert immediately.
  const { hostnameToDirName } = require('./certUtils.ts');
  const tlsDir = (config.get('letsEncrypt:tlsDir') as string | undefined) || 'var-pryv/tls';
  const materializedDir = path.join(tlsDir, hostnameToDirName(commonName));
  const materializedCert = path.join(materializedDir, 'fullchain.pem');
  const materializedKey = path.join(materializedDir, 'privkey.pem');
  if (fs.existsSync(materializedCert) && fs.existsSync(materializedKey)) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.mkdirSync(path.dirname(certFile), { recursive: true });
    fs.copyFileSync(materializedCert, certFile);
    fs.copyFileSync(materializedKey, keyFile);
    fs.chmodSync(certFile, 0o644);
    fs.chmodSync(keyFile, 0o600);
    log(`[acme] restored materialized LE cert for ${commonName} from ${materializedCert} -> ${certFile} (skipping self-signed placeholder; rotation IPC will still fanout on next ACME tick if cert changes)`);
    return { written: false, restored: true, reason: 'materialized-cert-restored', keyFile, certFile, source: materializedCert };
  }

  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    // SSL paths populated but no materialized cert — most likely an
    // operator-managed cert (custom TLS strategy or hand-renewed LE).
    // Leave it alone.
    return { written: false, reason: 'cert-files-already-exist' };
  }

  const { keyPem, certPem } = generate({ commonName, altNames });

  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.mkdirSync(path.dirname(certFile), { recursive: true });
  fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
  fs.writeFileSync(certFile, certPem, { mode: 0o644 });

  log(`[acme] wrote 1-day self-signed placeholder for ${commonName} at ${certFile} (real cert will hot-swap via setSecureContext when ACME completes)`);
  return { written: true, keyFile, certFile };
}

export { generate, ensure };