/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 34 — cluster CA and node-cert issuance.
 *
 * The first time the bootstrap CLI is invoked on a core, it generates a
 * self-signed cluster CA whose private key lives only on that core's
 * filesystem (never in PlatformDB). Every subsequent invocation signs a
 * node cert for the new core being provisioned.
 *
 * We shell out to openssl for the actual X.509 work — keygen + CSR + sign —
 * because Node's built-in `crypto` module can generate keys and parse
 * certificates but cannot sign them. The openssl binary is a standard
 * system dep on any Pryv.io host (already required for TLS in production).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const DEFAULT_CA_VALIDITY_DAYS = 3650; // 10 years
const DEFAULT_NODE_VALIDITY_DAYS = 365; // 1 year
const CA_SUBJECT = '/CN=pryv-cluster-ca';

class ClusterCA {
  /**
   * @param {Object} opts
   * @param {string} opts.dir - directory where ca.key and ca.crt live.
   *   The private key never leaves this directory; 0600 permissions are
   *   enforced. Callers are responsible for backing this directory up.
   * @param {number} [opts.caValidityDays=3650]
   * @param {number} [opts.nodeValidityDays=365]
   */
  constructor ({ dir, caValidityDays = DEFAULT_CA_VALIDITY_DAYS, nodeValidityDays = DEFAULT_NODE_VALIDITY_DAYS }) {
    if (!dir) throw new Error('ClusterCA: dir is required');
    this.dir = dir;
    this.caKeyPath = path.join(dir, 'ca.key');
    this.caCertPath = path.join(dir, 'ca.crt');
    this.caSerialPath = path.join(dir, 'ca.srl');
    this.caValidityDays = caValidityDays;
    this.nodeValidityDays = nodeValidityDays;
  }

  /**
   * Generate the cluster CA if it doesn't already exist. Safe to call
   * repeatedly. Returns an object describing whether the CA was newly
   * created on this call.
   * @returns {{ created: boolean, caCertPath: string }}
   */
  ensure () {
    if (fs.existsSync(this.caKeyPath) && fs.existsSync(this.caCertPath)) {
      return { created: false, caCertPath: this.caCertPath };
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });

    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', this.caKeyPath]);
    fs.chmodSync(this.caKeyPath, 0o600);

    openssl([
      'req', '-x509', '-new',
      '-key', this.caKeyPath,
      '-days', String(this.caValidityDays),
      '-out', this.caCertPath,
      '-subj', CA_SUBJECT
    ]);

    return { created: true, caCertPath: this.caCertPath };
  }

  /**
   * Read the CA public cert as a PEM string. Used to include the CA in the
   * bootstrap bundle so new cores can verify peer certs.
   * @returns {string}
   */
  getCACertPem () {
    if (!fs.existsSync(this.caCertPath)) {
      throw new Error(`CA cert not found at ${this.caCertPath}; call ensure() first`);
    }
    return fs.readFileSync(this.caCertPath, 'utf8');
  }

  /**
   * Issue a node cert signed by the cluster CA. The cert's SAN covers both
   * the core's hostname (for hostname-based peer verification) and its IP
   * (for direct-IP deployments and loopback dev setups).
   *
   * Returns the cert and private key as PEM strings. Nothing is written to
   * the CA directory except a serial-number bookkeeping file (openssl needs
   * a serial per signing).
   *
   * @param {Object} opts
   * @param {string} opts.coreId - e.g. 'core-b'. Used as the CN and as a DNS SAN.
   * @param {string|null} [opts.ip=null] - optional IP SAN (e.g. '1.2.3.4').
   * @param {string|null} [opts.hostname=null] - optional extra hostname SAN (e.g. 'core-b.mc.example.com').
   * @returns {{ certPem: string, keyPem: string }}
   */
  issueNodeCert ({ coreId, ip = null, hostname = null }) {
    if (!coreId) throw new Error('issueNodeCert: coreId is required');
    this.ensure();

    // All cert work happens in a temp dir so the CA directory only holds
    // the CA key + cert (and openssl's serial file).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-nodecert-'));
    try {
      const keyPath = path.join(tmp, 'node.key');
      const csrPath = path.join(tmp, 'node.csr');
      const certPath = path.join(tmp, 'node.crt');
      const extPath = path.join(tmp, 'node.ext');

      openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
      fs.chmodSync(keyPath, 0o600);

      openssl([
        'req', '-new',
        '-key', keyPath,
        '-out', csrPath,
        '-subj', `/CN=${coreId}`
      ]);

      fs.writeFileSync(extPath, buildSanExtfile({ coreId, ip, hostname }));

      openssl([
        'x509', '-req',
        '-in', csrPath,
        '-CA', this.caCertPath,
        '-CAkey', this.caKeyPath,
        '-CAcreateserial', '-CAserial', this.caSerialPath,
        '-days', String(this.nodeValidityDays),
        '-out', certPath,
        '-extfile', extPath
      ]);

      return {
        certPem: fs.readFileSync(certPath, 'utf8'),
        keyPem: fs.readFileSync(keyPath, 'utf8')
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function buildSanExtfile ({ coreId, ip, hostname }) {
  const sans = [`DNS:${coreId}`];
  if (hostname != null && hostname !== coreId) sans.push(`DNS:${hostname}`);
  if (ip != null) sans.push(`IP:${ip}`);
  return `subjectAltName = ${sans.join(', ')}\n`;
}

/**
 * Run openssl with captured output; throws a descriptive error on non-zero
 * exit. Swallowing stderr unless the command fails keeps the test output
 * clean while preserving diagnostics when something goes wrong.
 */
function openssl (args) {
  try {
    execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`openssl ${args[0]} failed: ${err.message}\n${stderr}`);
  }
}

module.exports = ClusterCA;
