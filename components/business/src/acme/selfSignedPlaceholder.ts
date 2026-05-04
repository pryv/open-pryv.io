/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


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

/**
 * Generate a 1-day self-signed RSA-2048 cert valid for `commonName` and
 * `altNames`. Returns { keyPem, certPem }.
 */
function generate ({ commonName, altNames = [] }) {
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
 * @param {Object} opts
 * @param {Object} opts.config        - @pryv/boiler config
 * @param {Object} [opts.deriveHostnames] - injectable for tests; defaults to ../deriveHostnames
 * @param {Function} [opts.log]       - logger
 * @returns {{ written: boolean, reason?: string, keyFile?: string, certFile?: string }}
 */
function ensure ({ config, deriveHostnames: deriveHostnamesFn, log = (_: any) => {} }: any = {}) {
  if (!config.get('letsEncrypt:enabled')) {
    return { written: false, reason: 'letsEncrypt-disabled' };
  }
  const keyFile = config.get('http:ssl:keyFile');
  const certFile = config.get('http:ssl:certFile');
  if (!keyFile || !certFile) {
    return { written: false, reason: 'ssl-paths-not-configured' };
  }
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    // Real cert already on disk (previous ACME issuance survived restart).
    return { written: false, reason: 'cert-files-already-exist' };
  }

  const derive = deriveHostnamesFn || require('./deriveHostnames').deriveHostnames;
  const { commonName, altNames } = derive(config);

  const { keyPem, certPem } = generate({ commonName, altNames });

  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.mkdirSync(path.dirname(certFile), { recursive: true });
  fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
  fs.writeFileSync(certFile, certPem, { mode: 0o644 });

  log(`[acme] wrote 1-day self-signed placeholder for ${commonName} at ${certFile} (real cert will hot-swap via setSecureContext when ACME completes)`);
  return { written: true, keyFile, certFile };
}

module.exports = { generate, ensure };
