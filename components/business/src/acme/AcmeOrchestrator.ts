/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Runtime orchestrator for the Let's Encrypt integration. One of these is
 * instantiated by `bin/master.js` when `letsEncrypt.enabled: true` and
 * lives for the life of the master process.
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

const { CertRenewer, PlatformDBDnsWriter } = require('./CertRenewer.ts');
const { FileMaterializer, runRotateScript } = require('./FileMaterializer.ts');
const { deriveHostnames } = require('./deriveHostnames.ts');

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_RENEW_INTERVAL_MS = DAY_MS;
const DEFAULT_MATERIALIZE_INTERVAL_MS = 60 * 1000;
// Before the first cert has been issued, ticks fire at a much faster
// cadence so a transient first-boot validation failure (typical cause:
// public-recursor negative-cache hangover from before this host was
// authoritative) clears within minutes instead of the renew cadence's
// 24h. Once `getCertificate(host)` returns non-null, the timer
// downshifts to the renew cadence and stays there.
const DEFAULT_INITIAL_RETRY_INTERVAL_MS = 60 * 1000;

type LogFn = (msg: string) => void;
type CertRenewerLike = {
  renew: (opts: { hostname: string; altNames: string[]; dnsWriter?: unknown; http01Store?: unknown; challengePriority?: string[] }) => Promise<{ hostname: string; expiresAt: number; [k: string]: unknown }>;
  getCertificate: (hostname: string) => Promise<{ expiresAt: number; [k: string]: unknown } | null>;
};
type FileMaterializerLike = {
  checkOnce: () => Promise<{ rotated: boolean; reason?: string; [k: string]: unknown }>;
};
type HostSpec = { commonName: string; altNames: string[]; challenge: string };
type DnsWriterLike = unknown;
type Http01StoreLike = unknown;

interface AcmeOrchestratorOpts {
  hostSpec: HostSpec;
  certRenewer: CertRenewerLike;
  fileMaterializer: FileMaterializerLike;
  dnsWriter: DnsWriterLike;
  http01Store?: Http01StoreLike;
  isRenewer?: boolean;
  renewBeforeDays?: number;
  renewIntervalMs?: number;
  initialRetryIntervalMs?: number;
  materializeIntervalMs?: number;
  log?: LogFn;
}

class AcmeOrchestrator {
  #certRenewer: CertRenewerLike;
  #fileMaterializer: FileMaterializerLike;
  #hostSpec: HostSpec;
  #isRenewer: boolean;
  #renewBeforeMs: number;
  #renewIntervalMs: number;
  #initialRetryIntervalMs: number;
  #materializeIntervalMs: number;
  #dnsWriter: DnsWriterLike;
  #http01Store: Http01StoreLike | undefined;
  #log: LogFn;
  #renewTimer: NodeJS.Timeout | null = null;
  #materializeTimer: NodeJS.Timeout | null = null;
  #currentRenewIntervalMs = 0;
  #renewInFlight = false;

  /**
   * @param opts.hostSpec           - output of deriveHostnames()
   * @param opts.certRenewer        - a CertRenewer instance
   * @param opts.fileMaterializer   - a FileMaterializer instance for hostSpec.commonName
   * @param opts.dnsWriter          - dnsWriter passed into certRenewer.renew()
   * @param [opts.isRenewer=false] - if true, this core runs ACME; otherwise poll-only
   * @param [opts.renewBeforeDays=30]
   * @param [opts.renewIntervalMs=DAY_MS]
   * @param [opts.materializeIntervalMs=60_000]
   * @param [opts.log]
   */
  constructor ({
    hostSpec, certRenewer, fileMaterializer, dnsWriter, http01Store,
    isRenewer = false,
    renewBeforeDays = 30,
    renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
    initialRetryIntervalMs = DEFAULT_INITIAL_RETRY_INTERVAL_MS,
    materializeIntervalMs = DEFAULT_MATERIALIZE_INTERVAL_MS,
    log
  }: AcmeOrchestratorOpts = {} as AcmeOrchestratorOpts) {
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
    this.#initialRetryIntervalMs = initialRetryIntervalMs;
    this.#materializeIntervalMs = materializeIntervalMs;
    this.#dnsWriter = dnsWriter;
    this.#http01Store = http01Store;
    this.#log = log || ((msg: string) => console.log('[acme] ' + msg));
  }

  /**
   * Kick off the intervals. Safe to call once per process.
   */
  start () {
    if (this.#renewTimer || this.#materializeTimer) {
      throw new Error('AcmeOrchestrator.start: already running');
    }
    this.#log(`starting (host=${this.#hostSpec.commonName} challenge=${this.#hostSpec.challenge} renewer=${this.#isRenewer})`);

    // HTTP-01 challenge requires an Http01ChallengeStore passed in by the
    // master process (which also runs the :80 challenge server reading
    // from it). If the operator selects http-01 (typically via
    // dnsLess.isActive=true) but the master didn't wire a store, the
    // ACME flow would silently hang at validation. Refuse loudly instead.
    if (this.#isRenewer && this.#hostSpec.challenge === 'http-01' && this.#http01Store == null) {
      const banner = '═'.repeat(70);
      this.#log(banner);
      this.#log('FATAL: HTTP-01 challenge selected but no Http01ChallengeStore wired.');
      this.#log(`host=${this.#hostSpec.commonName}`);
      this.#log('');
      this.#log('This is an internal wiring bug — the master process should have created');
      this.#log('the store + bound the challenge server on :80 before constructing the');
      this.#log('AcmeOrchestrator. Check bin/master.js letsEncrypt setup block.');
      this.#log(banner);
      // Do not start the renew loop; placeholder stays on :443.
    }

    // Always materialize — every core publishes the current cert to disk.
    this.#materializeTimer = setInterval(() => {
      this.triggerMaterialize().catch(err => this.#log('materialize tick error: ' + err.message));
    }, this.#materializeIntervalMs);
    // Prime immediately so a freshly-booted core doesn't wait a minute
    // for its first cert write.
    this.triggerMaterialize().catch(err => this.#log('initial materialize error: ' + err.message));

    // Only start the renew loop if (renewer AND we have what we need for the
    // configured challenge type). http-01 needs the store; dns-01 needs the
    // writer (which is always present).
    const canRunHttp01 = this.#hostSpec.challenge !== 'http-01' || this.#http01Store != null;
    if (this.#isRenewer && canRunHttp01) {
      // Arm at the fast initial-retry cadence by default; triggerRenewCheck()
      // downshifts to renewIntervalMs the moment a stored cert is observed
      // (either because issuance just succeeded or because a previous boot
      // already obtained one).
      this.#armRenewTimer(this.#initialRetryIntervalMs);
      this.triggerRenewCheck().catch(err => this.#logRenewError('initial renew', err));
    }
  }

  /**
   * (Re)arm the renew timer at the given cadence. Idempotent — clears the
   * current timer first; no-op if intervalMs matches the active cadence.
   */
  #armRenewTimer (intervalMs: number) {
    if (this.#currentRenewIntervalMs === intervalMs && this.#renewTimer) return;
    if (this.#renewTimer) { clearInterval(this.#renewTimer); this.#renewTimer = null; }
    this.#renewTimer = setInterval(() => {
      this.triggerRenewCheck().catch(err => this.#logRenewError('renew tick', err));
    }, intervalMs);
    this.#currentRenewIntervalMs = intervalMs;
    if (intervalMs === this.#initialRetryIntervalMs) {
      this.#log(`renew tick cadence = ${Math.round(intervalMs / 1000)}s (initial retry; downshifts after first issuance)`);
    } else {
      this.#log(`renew tick cadence = ${Math.round(intervalMs / 3600000)}h (steady-state)`);
    }
  }

  // Verbose error logger for renew failures: prints the full error message
  // PLUS the most common causes for HTTP-01 / DNS-01 failures so the
  // operator doesn't have to grep through acme-client's terse "Could not
  // validate authorization" with no context.
  #logRenewError (phase: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const banner = '─'.repeat(60);
    this.#log(banner);
    this.#log(`${phase} ERROR for host=${this.#hostSpec.commonName}`);
    this.#log(`challenge=${this.#hostSpec.challenge}`);
    this.#log(`message: ${msg}`);
    if (/authorization|invalid|validation|unauthorized/i.test(msg)) {
      if (this.#hostSpec.challenge === 'dns-01') {
        this.#log('Hint (DNS-01): the embedded DNS server must answer TXT queries for');
        this.#log(`  _acme-challenge.${this.#hostSpec.commonName} — check that NS records for`);
        this.#log('  the zone point at this host and UDP/53 is reachable from LE.');
      } else if (this.#hostSpec.challenge === 'http-01') {
        this.#log('Hint (HTTP-01): LE GETs http://' + this.#hostSpec.commonName + '/.well-known/acme-challenge/<token>');
        this.#log('  Ensure TCP/80 is published (-p 80:80) AND reachable from the public internet');
        this.#log('  (firewall / security group / NAT). For AWS: open inbound :80 to 0.0.0.0/0.');
      }
    }
    if (/rate ?limit|too many|429/i.test(msg)) {
      this.#log('Hint: LE production rate limit hit. Set letsEncrypt.staging=true temporarily,');
      this.#log('  fix the validation path, then flip staging=false once issuance succeeds.');
    }
    if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
      this.#log('Hint: network reachability — verify the challenge endpoint is reachable from');
      this.#log('  the public internet (firewall, security group, NAT, DNS record).');
    }
    this.#log(banner);
    if (process.env.DEBUG) {
      this.#log(err instanceof Error && err.stack ? err.stack : '(no stack available)');
    }
  }

  stop () {
    if (this.#renewTimer) { clearInterval(this.#renewTimer); this.#renewTimer = null; }
    if (this.#materializeTimer) { clearInterval(this.#materializeTimer); this.#materializeTimer = null; }
  }

  /**
   * True when this core runs the daily ACME loop. Surfaced for the admin
   * `force-renew` route's pre-flight check so non-renewer cores can fail
   * fast with a 400 instead of attempting the IPC round-trip.
   */
  get isRenewer () {
    return this.#isRenewer;
  }

  /**
   * Issue a new cert immediately, ignoring the stored cert's expiresAt.
   * Materializes the result on this core right away (other cores pick it
   * up via their next materialize tick + the master's existing
   * `acme:rotate` IPC broadcast).
   *
   * Use cases: admin-triggered rotation (key compromise, brand-new cert
   * testing, debugging). Throws when called on a non-renewer core.
   *
   * @param [hostname] - defaults to the core's primary hostname.
   */
  async forceRenew (hostname?: string) {
    if (!this.#isRenewer) {
      throw new Error('AcmeOrchestrator.forceRenew: not the certRenewer core');
    }
    const target = hostname ?? this.#hostSpec.commonName;
    this.#log(`forceRenew: ${target} (skipping expiry check)`);
    return this.#issue(target);
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
    // Single-flight: the initial-retry cadence (60s) can fire a tick
    // while the immediate start()-side issuance is still walking the
    // LE order — without this guard two issuances run concurrently,
    // burning quota + producing confusing logs (success of one + a
    // stale error of the other on the same boot). The tick is cheap;
    // a no-op until the in-flight call settles is the right shape.
    if (this.#renewInFlight) return { skipped: true, reason: 'in-flight' };
    const hostname = this.#hostSpec.commonName;
    const stored = await this.#certRenewer.getCertificate(hostname);

    if (stored == null) {
      this.#log(`no cert for ${hostname} — issuing initial`);
      return this.#withInFlight(() => this.#issue());
    }
    // A stored cert exists — the initial-retry cadence is no longer
    // helpful; downshift to the steady-state renew cadence.
    this.#armRenewTimer(this.#renewIntervalMs);
    const daysLeft = Math.round((stored.expiresAt - now) / DAY_MS);
    if (stored.expiresAt - now > this.#renewBeforeMs) {
      return { skipped: true, reason: 'not-yet-due', daysLeft };
    }
    this.#log(`${hostname} expires in ${daysLeft} day(s) — renewing`);
    return this.#withInFlight(() => this.#issue());
  }

  async #withInFlight<T> (work: () => Promise<T>): Promise<T> {
    this.#renewInFlight = true;
    try {
      return await work();
    } finally {
      this.#renewInFlight = false;
    }
  }

  async #issue (hostname?: string) {
    const target = hostname ?? this.#hostSpec.commonName;
    const isPrimary = target === this.#hostSpec.commonName;
    const result = await this.#certRenewer.renew({
      hostname: target,
      // altNames + challengePriority only apply when issuing for the
      // primary hostname this orchestrator was built for. A force-renew
      // pointing at a different hostname falls back to defaults.
      altNames: isPrimary ? this.#hostSpec.altNames : [],
      dnsWriter: this.#dnsWriter,
      http01Store: this.#http01Store,
      challengePriority: isPrimary ? [this.#hostSpec.challenge] : undefined
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
 * @param opts.config             - @pryv/boiler config
 * @param opts.platformDB
 * @param opts.atRestKey
 * @param [opts.dnsServer]        - optional; when provided, the DNS-01 TXT writer forces an immediate refreshFromPlatform() after each PlatformDB write so LE validators see the challenge record without waiting for the DnsServer's periodic refresh tick. Without it, LE often times out on "No TXT records found".
 * @param [opts.onRotate]       - called after each successful on-disk write (see FileMaterializer)
 * @param [opts.acmeLib]
 * @param [opts.log]
 */
interface BuildOpts {
  config: { get: (key: string) => unknown };
  platformDB: unknown;
  atRestKey: unknown;
  dnsServer?: unknown;
  http01Store?: unknown;
  onRotate?: (certPath: string, keyPath: string, hostname: string) => Promise<void> | void;
  acmeLib?: unknown;
  log?: LogFn;
}

function build (opts: BuildOpts = {} as BuildOpts) {
  const { config, platformDB, atRestKey, dnsServer, http01Store, onRotate, acmeLib, log } = opts;
  if (config == null) throw new Error('AcmeOrchestrator.build: config is required');

  const hostSpec = deriveHostnames(config);
  const email = config.get('letsEncrypt:email');
  if (!email || email === 'REPLACE ME') {
    throw new Error('AcmeOrchestrator.build: letsEncrypt.email is required');
  }
  const staging = !!config.get('letsEncrypt:staging');
  const renewBeforeDays = (config.get('letsEncrypt:renewBeforeDays') ?? 30) as number;
  const tlsDir = (config.get('letsEncrypt:tlsDir') || 'var-pryv/tls') as string;
  const isRenewer = !!config.get('letsEncrypt:certRenewer');
  const onRotateScript = (config.get('letsEncrypt:onRotateScript') || null) as string | null;
  const directoryUrl = (config.get('letsEncrypt:directoryUrl') ||
    (staging
      ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
      : 'https://acme-v02.api.letsencrypt.org/directory')) as string;

  const certRenewer = new CertRenewer({
    platformDB, atRestKey, email, directoryUrl, acmeLib
  });

  const fileMaterializer = new FileMaterializer({
    certRenewer,
    tlsDir,
    hostname: hostSpec.commonName,
    onRotate: async (certPath: string, keyPath: string, hostname: string) => {
      if (typeof onRotate === 'function') {
        try { await onRotate(certPath, keyPath, hostname); } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          (log || console.log)('[acme] onRotate (caller) failed: ' + message);
        }
      }
      if (onRotateScript) {
        try {
          const r = await runRotateScript({ scriptPath: onRotateScript, hostname, certPath, keyPath });
          (log || console.log)(`[acme] onRotateScript ${onRotateScript} exit=${r.exitCode}`);
          if (r.stderr) (log || console.log)('[acme] onRotateScript stderr: ' + r.stderr.trim());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          (log || console.log)('[acme] onRotateScript spawn failed: ' + message);
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
    http01Store,
    isRenewer,
    renewBeforeDays,
    log
  });
}

export { AcmeOrchestrator, build, DAY_MS };