/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 35 Phase 4b — runtime orchestrator for the Let's Encrypt
 * integration. One of these is instantiated by `bin/master.js` when
 * `letsEncrypt.enabled: true` and lives for the life of the master
 * process.
 *
 * Responsibilities:
 *   1. File materialization — every core (renewer or not) polls
 *      PlatformDB and writes the current cert to local disk when it
 *      rotates. Drives the operator's `onRotateScript` + the caller's
 *      `onRotate(certPath, keyPath, hostname)` hook (so master.js can
 *      call https.Server.setSecureContext).
 *   2. Renewal — only the core with `letsEncrypt.certRenewer: true`
 *      runs the daily check. For each host in scope, if the stored
 *      cert expires within `renewBeforeDays`, issue a new one via
 *      CertRenewer.renew(). On first run with no stored cert, issue
 *      one straight away.
 *
 * This class owns the setInterval/clearInterval plumbing and nothing
 * else. CertRenewer + FileMaterializer + deriveHostnames do the work.
 */

const { CertRenewer, PlatformDBDnsWriter } = require('./CertRenewer');
const { FileMaterializer, runRotateScript } = require('./FileMaterializer');
const { deriveHostnames } = require('./deriveHostnames');

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_RENEW_INTERVAL_MS = DAY_MS;
const DEFAULT_MATERIALIZE_INTERVAL_MS = 60 * 1000;

class AcmeOrchestrator {
  #certRenewer;
  #fileMaterializer;
  #hostSpec;
  #isRenewer;
  #renewBeforeMs;
  #renewIntervalMs;
  #materializeIntervalMs;
  #dnsWriter;
  #log;
  #renewTimer;
  #materializeTimer;

  /**
   * @param {Object} opts
   * @param {Object} opts.hostSpec           - output of deriveHostnames()
   * @param {Object} opts.certRenewer        - a CertRenewer instance
   * @param {Object} opts.fileMaterializer   - a FileMaterializer instance for hostSpec.commonName
   * @param {Object} opts.dnsWriter          - dnsWriter passed into certRenewer.renew()
   * @param {boolean} [opts.isRenewer=false] - if true, this core runs ACME; otherwise poll-only
   * @param {number} [opts.renewBeforeDays=30]
   * @param {number} [opts.renewIntervalMs=DAY_MS]
   * @param {number} [opts.materializeIntervalMs=60_000]
   * @param {Function} [opts.log]
   */
  constructor ({
    hostSpec, certRenewer, fileMaterializer, dnsWriter,
    isRenewer = false,
    renewBeforeDays = 30,
    renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
    materializeIntervalMs = DEFAULT_MATERIALIZE_INTERVAL_MS,
    log
  } = {}) {
    if (hostSpec == null) throw new Error('AcmeOrchestrator: hostSpec is required');
    if (certRenewer == null) throw new Error('AcmeOrchestrator: certRenewer is required');
    if (fileMaterializer == null) throw new Error('AcmeOrchestrator: fileMaterializer is required');
    if (dnsWriter == null) throw new Error('AcmeOrchestrator: dnsWriter is required');
    this.#certRenewer = certRenewer;
    this.#fileMaterializer = fileMaterializer;
    this.#hostSpec = hostSpec;
    this.#isRenewer = isRenewer;
    this.#renewBeforeMs = renewBeforeDays * DAY_MS;
    this.#renewIntervalMs = renewIntervalMs;
    this.#materializeIntervalMs = materializeIntervalMs;
    this.#dnsWriter = dnsWriter;
    this.#log = log || (msg => console.log('[acme] ' + msg));
  }

  /**
   * Kick off the intervals. Safe to call once per process.
   */
  start () {
    if (this.#renewTimer || this.#materializeTimer) {
      throw new Error('AcmeOrchestrator.start: already running');
    }
    this.#log(`starting (host=${this.#hostSpec.commonName} challenge=${this.#hostSpec.challenge} renewer=${this.#isRenewer})`);

    // Always materialize — every core publishes the current cert to disk.
    this.#materializeTimer = setInterval(() => {
      this.triggerMaterialize().catch(err => this.#log('materialize tick error: ' + err.message));
    }, this.#materializeIntervalMs);
    // Prime immediately so a freshly-booted core doesn't wait a minute
    // for its first cert write.
    this.triggerMaterialize().catch(err => this.#log('initial materialize error: ' + err.message));

    if (this.#isRenewer) {
      this.#renewTimer = setInterval(() => {
        this.triggerRenewCheck().catch(err => this.#log('renew tick error: ' + err.message));
      }, this.#renewIntervalMs);
      this.triggerRenewCheck().catch(err => this.#log('initial renew error: ' + err.message));
    }
  }

  stop () {
    if (this.#renewTimer) { clearInterval(this.#renewTimer); this.#renewTimer = null; }
    if (this.#materializeTimer) { clearInterval(this.#materializeTimer); this.#materializeTimer = null; }
  }

  /**
   * One materialize tick — poll PlatformDB, write to disk if changed.
   * Exposed for tests and for an admin "force-reload" endpoint (future).
   */
  async triggerMaterialize () {
    const result = await this.#fileMaterializer.checkOnce();
    if (result.rotated) {
      this.#log(`materialized ${this.#hostSpec.commonName}: ${result.reason}`);
    }
    return result;
  }

  /**
   * One renewer tick — check the stored cert's expiresAt and renew if
   * it's within `renewBeforeDays`. Also issues the initial cert when
   * none is stored yet. No-op when this core is not the renewer.
   */
  async triggerRenewCheck ({ now = Date.now() } = {}) {
    if (!this.#isRenewer) return { skipped: true, reason: 'not-renewer' };
    const hostname = this.#hostSpec.commonName;
    const stored = await this.#certRenewer.getCertificate(hostname);

    if (stored == null) {
      this.#log(`no cert for ${hostname} — issuing initial`);
      return this.#issue();
    }
    const daysLeft = Math.round((stored.expiresAt - now) / DAY_MS);
    if (stored.expiresAt - now > this.#renewBeforeMs) {
      return { skipped: true, reason: 'not-yet-due', daysLeft };
    }
    this.#log(`${hostname} expires in ${daysLeft} day(s) — renewing`);
    return this.#issue();
  }

  async #issue () {
    const result = await this.#certRenewer.renew({
      hostname: this.#hostSpec.commonName,
      altNames: this.#hostSpec.altNames,
      dnsWriter: this.#dnsWriter,
      challengePriority: [this.#hostSpec.challenge]
    });
    this.#log(`issued ${result.hostname} (expires ${new Date(result.expiresAt).toISOString()})`);
    // Trigger an immediate materialize so the new cert lands on disk on
    // THIS core right away (other cores pick it up on their next tick).
    await this.triggerMaterialize();
    return { renewed: true, ...result };
  }
}

/**
 * Build an AcmeOrchestrator from runtime wiring that `bin/master.js`
 * typically has access to. Saves the master process from knowing the
 * construction order of CertRenewer / FileMaterializer / PlatformDBDnsWriter.
 *
 * @param {Object} opts
 * @param {Object} opts.config             - @pryv/boiler config
 * @param {Object} opts.platformDB
 * @param {Buffer} opts.atRestKey
 * @param {Object} [opts.dnsServer]        - optional; when provided, the DNS-01 TXT writer forces an immediate refreshFromPlatform() after each PlatformDB write so LE validators see the challenge record without waiting for the DnsServer's periodic refresh tick. Without it, LE often times out on "No TXT records found".
 * @param {Function} [opts.onRotate]       - called after each successful on-disk write (see FileMaterializer)
 * @param {Object}   [opts.acmeLib]
 * @param {Function} [opts.log]
 */
function build (opts = {}) {
  const { config, platformDB, atRestKey, dnsServer, onRotate, acmeLib, log } = opts;
  if (config == null) throw new Error('AcmeOrchestrator.build: config is required');

  const hostSpec = deriveHostnames(config);
  const email = config.get('letsEncrypt:email');
  if (!email || email === 'REPLACE ME') {
    throw new Error('AcmeOrchestrator.build: letsEncrypt.email is required');
  }
  const staging = !!config.get('letsEncrypt:staging');
  const renewBeforeDays = config.get('letsEncrypt:renewBeforeDays') ?? 30;
  const tlsDir = config.get('letsEncrypt:tlsDir') || 'var-pryv/tls';
  const isRenewer = !!config.get('letsEncrypt:certRenewer');
  const onRotateScript = config.get('letsEncrypt:onRotateScript') || null;
  const directoryUrl = config.get('letsEncrypt:directoryUrl') ||
    (staging
      ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
      : 'https://acme-v02.api.letsencrypt.org/directory');

  const certRenewer = new CertRenewer({
    platformDB, atRestKey, email, directoryUrl, acmeLib
  });

  const fileMaterializer = new FileMaterializer({
    certRenewer,
    tlsDir,
    hostname: hostSpec.commonName,
    onRotate: async (certPath, keyPath, hostname) => {
      if (typeof onRotate === 'function') {
        try { await onRotate(certPath, keyPath, hostname); } catch (err) {
          (log || console.log)('[acme] onRotate (caller) failed: ' + err.message);
        }
      }
      if (onRotateScript) {
        try {
          const r = await runRotateScript({ scriptPath: onRotateScript, hostname, certPath, keyPath });
          (log || console.log)(`[acme] onRotateScript ${onRotateScript} exit=${r.exitCode}`);
          if (r.stderr) (log || console.log)('[acme] onRotateScript stderr: ' + r.stderr.trim());
        } catch (err) {
          (log || console.log)('[acme] onRotateScript spawn failed: ' + err.message);
        }
      }
    },
    log
  });

  const dnsWriter = new PlatformDBDnsWriter({ platformDB, dnsServer });

  return new AcmeOrchestrator({
    hostSpec,
    certRenewer,
    fileMaterializer,
    dnsWriter,
    isRenewer,
    renewBeforeDays,
    log
  });
}

module.exports = {
  AcmeOrchestrator,
  build,
  DAY_MS
};
