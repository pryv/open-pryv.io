/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';
const require = createRequire(import.meta.url);
/**
 * Bootstrap-mode driver for `bin/master.js --bootstrap`.
 *
 * Walks a fresh core through the consume-side of the bootstrap dance:
 *   1. Read the armored bundle file from `bundlePath`.
 *   2. Resolve the passphrase from `--bootstrap-passphrase-file` (preferred)
 *      or interactively from a TTY. Tests inject `passphrase` directly.
 *   3. stageBundle(...) — decrypt, validate, write override-config.yml and
 *      the TLS files to a private staging directory (see ./applyBundle.js).
 *   4. POST {coreId, token, tlsFingerprint} to the bundle's ackUrl, with the
 *      bundled CA cert pinned (`ca:` option on the https request) so we
 *      refuse to ack any TLS endpoint that isn't issued by the cluster CA.
 *      `trustSystemCa` drops the pin and verifies against the system CA
 *      store instead (for cores whose API origin is fronted by a public/ACME
 *      cert); the join token remains the authenticator.
 *   5. On a 200, move the staged files into place; on any failure before
 *      that (clock skew, network, refused ack), remove them, so a refused
 *      join leaves no platform secret and no node key on disk.
 *   6. Delete the original bundle file on success — once acked, the bundle
 *      is spent (the join token has been burned on the issuing core).
 *
 * Pure-ish: no boiler, no PlatformDB, no rqlited. The httpClient dep is
 * injectable so unit tests can stand in a fake POST that returns canned
 * status codes.
 */

const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const applyBundleMod = require('./applyBundle.ts');

interface HttpResponse {
  statusCode: number | undefined;
  body: unknown;
}
type HttpClient = (url: string, payload: Record<string, unknown>, caCertPem: string) => Promise<HttpResponse>;
type ClockProbeResult = { serverTimeMs: number; rttMs: number; localMs: number } | null;
type ClockProbe = (originUrl: string, caCertPem: string) => Promise<ClockProbeResult>;

interface ConsumeOpts {
  bundlePath: string;
  passphrase?: string;
  passphraseFile?: string;
  configDir: string;
  tlsDir: string;
  httpClient?: HttpClient;
  trustSystemCa?: boolean;
  asNonVoter?: boolean;
  clockSkewSeconds?: number;
  clockProbe?: ClockProbe;
  log?: (msg: string) => void;
}

interface ConsumeResult {
  coreId: string;
  ackResponse: unknown;
  overridePath: string;
  tlsPaths: Record<string, string>;
  bundleDeleted: boolean;
}

/**
 * @param opts.bundlePath - path to the armored .json.age (or any name) file
 * @param [opts.passphrase] - if given, used directly (test path)
 * @param [opts.passphraseFile] - read from this file; trim trailing newlines
 * @param opts.configDir
 * @param opts.tlsDir
 * @param [opts.httpClient] - (url, body, caCertPem) => Promise<{ statusCode, body }>;
 *                                       defaults to a CA-pinned node https POST
 * @param [opts.clockSkewSeconds] - refuse the join (before the ack) when this
 *                                  core's clock differs from the issuing core's
 *                                  by more; default 30, 0 disables
 * @param [opts.clockProbe] - (originUrl, caCertPem) => Promise<{ serverTimeMs, rttMs, localMs } | null>;
 *                            defaults to a GET of the issuing core's root
 * @param [opts.log] - logger; default = console.log
 *   coreId: string,
 *   ackResponse: Object,
 *   overridePath: string,
 *   tlsPaths: Object,
 *   bundleDeleted: boolean
 * }>}
 */
async function consume (opts: ConsumeOpts): Promise<ConsumeResult> {
  const {
    bundlePath, passphrase, passphraseFile, configDir, tlsDir,
    httpClient = defaultHttpClient,
    trustSystemCa = false,
    asNonVoter = true,
    clockSkewSeconds = 30,
    clockProbe = defaultClockProbe,
    log = (m: string) => console.log('[bootstrap] ' + m)
  } = opts || ({} as ConsumeOpts);

  if (!bundlePath) throw new Error('consume: bundlePath is required');
  if (!configDir) throw new Error('consume: configDir is required');
  if (!tlsDir) throw new Error('consume: tlsDir is required');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`consume: bundle file not found at ${bundlePath}`);
  }

  const armoredBundle = fs.readFileSync(bundlePath, 'utf8');
  const resolvedPassphrase = resolvePassphrase({ passphrase, passphraseFile });

  log(`Applying bundle ${bundlePath} ...`);
  if (asNonVoter) {
    log('Joining as a NON-VOTER (default): this core replicates the platform ' +
      'DB and forwards writes to the leader, but does not count toward Raft ' +
      'quorum, so it cannot stall the cluster if it becomes unreachable.');
  } else {
    log('Joining as a VOTER (--bootstrap-as-voter): this core counts toward ' +
      'Raft quorum. Only safe at >=3 voters — two voters give a 2-of-2 cluster ' +
      'where either core dying is an outage.');
  }
  // Secrets and the node key stay in a staging directory until the issuing
  // core accepts the ack; any failure before that removes them.
  const applied = await applyBundleMod.stageBundle({
    armoredBundle, passphrase: resolvedPassphrase, configDir, tlsDir, asNonVoter
  });
  log(`Staged the bundle files in ${applied.stagingDir}`);
  let ackResponse: HttpResponse;
  try {
    ackResponse = await checkClockAndAck({ applied, trustSystemCa, clockSkewSeconds, clockProbe, httpClient, log });
  } catch (err) {
    try {
      applied.discard();
      log('Removed the staged files: nothing was written to ' + configDir + ' or ' + tlsDir);
    } catch (cleanupErr) {
      log(`Warning: could not remove the staging directory ${applied.stagingDir}: ${(cleanupErr as Error).message}; delete it by hand, it holds platform secrets`);
    }
    throw err;
  }

  try {
    applied.commit();
  } catch (err) {
    throw new Error(`ack accepted (the join token is spent) but moving the staged files into place failed: ${(err as Error).message}. ` +
      `The files are in ${applied.stagingDir}: move them to ${tlsDir} and ${applied.overridePath} by hand, then start the core without --bootstrap.`);
  }
  log(`Wrote ${applied.overridePath}`);
  log(`Wrote TLS files in ${tlsDir}`);

  let bundleDeleted = false;
  try {
    fs.unlinkSync(bundlePath);
    bundleDeleted = true;
    log(`Deleted bundle file ${bundlePath} (token has been burned).`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Warning: could not delete bundle file ${bundlePath}: ${message}`);
  }

  return {
    coreId: applied.coreId,
    ackResponse: ackResponse.body,
    overridePath: applied.overridePath,
    tlsPaths: applied.tlsPaths,
    bundleDeleted
  };
}

type StagedLike = { bundle: { cluster: { ca: { certPem: string } } }; ackUrl: string; coreId: string; joinToken: string; tlsFingerprint: string };

async function checkClockAndAck ({ applied, trustSystemCa, clockSkewSeconds, clockProbe, httpClient, log }: { applied: StagedLike; trustSystemCa: boolean; clockSkewSeconds: number; clockProbe: ClockProbe; httpClient: HttpClient; log: (msg: string) => void }): Promise<HttpResponse> {
  // By default we pin the cluster CA on the ack POST, refusing any TLS
  // endpoint not issued by the cluster CA. But the ack URL is the existing
  // core's normal API origin, which on any internet-facing deploy terminates
  // TLS with a PUBLIC CA (ACME) cert — so the pin would fail with
  // `unable to get local issuer certificate`. `trustSystemCa` relaxes only
  // TRANSPORT trust to "DNS + public CA" (still rejectUnauthorized); the
  // one-shot join token remains the real authenticator of the ack.
  const ackCa = trustSystemCa ? '' : applied.bundle.cluster.ca.certPem;
  if (trustSystemCa) {
    log('ack-trust-system-ca: verifying ack against the system CA store ' +
      '(transport trust = DNS + public CA; join token remains the authenticator)');
  }

  // Check this core's clock against the issuing core's BEFORE the ack: once
  // acked, the token is burned and the cluster considers this core up.
  await checkClockSkew({
    origin: new URL(applied.ackUrl).origin, caCertPem: ackCa, clockSkewSeconds, clockProbe, log
  });

  log(`Acking to ${applied.ackUrl} ...`);
  const ackResponse = await httpClient(
    applied.ackUrl,
    {
      coreId: applied.coreId,
      token: applied.joinToken,
      tlsFingerprint: applied.tlsFingerprint
    },
    ackCa
  );
  if (ackResponse.statusCode !== 200) {
    throw new Error(
      `ack failed: HTTP ${ackResponse.statusCode}: ` +
      JSON.stringify(ackResponse.body)
    );
  }
  const ackBody = ackResponse.body as { cluster?: { cores?: unknown[] } } | null;
  log(`Ack accepted; cluster has ${ackBody?.cluster?.cores?.length ?? '?'} core(s)`);
  return ackResponse;
}

async function checkClockSkew ({ origin, caCertPem, clockSkewSeconds, clockProbe, log }: { origin: string; caCertPem: string; clockSkewSeconds: number; clockProbe: ClockProbe; log: (msg: string) => void }): Promise<void> {
  if (!(clockSkewSeconds > 0)) {
    log('clock-skew check skipped: disabled (--bootstrap-clock-skew-seconds 0)');
    return;
  }
  let probe: ClockProbeResult;
  try {
    probe = await clockProbe(origin + '/', caCertPem);
  } catch (err) {
    throw new Error(`clock probe GET ${origin}/ failed: ${(err as Error).message}`);
  }
  if (probe == null) {
    log(`clock-skew check skipped: no server time in the answer from ${origin}`);
    return;
  }
  const skewMs = probe.localMs - probe.serverTimeMs;
  const iso = (ms: number) => new Date(ms).toISOString();
  const skewText = (skewMs >= 0 ? '+' : '-') + (Math.abs(skewMs) / 1000).toFixed(1) + 's';
  const facts = `local=${iso(probe.localMs)} issuer=${iso(probe.serverTimeMs)} rtt=${probe.rttMs}ms`;
  if (Math.abs(skewMs) > clockSkewSeconds * 1000) {
    log(`clock skew of ${skewText} vs the issuing core ${origin} exceeds ${clockSkewSeconds}s (${facts}). ` +
      'Fix this host\'s clock (chronyd/ntpd) and re-run --bootstrap; raise ' +
      '--bootstrap-clock-skew-seconds or pass 0 to override.');
    throw new Error(`clock skew of ${skewText} vs the issuing core exceeds ${clockSkewSeconds}s; the join token was not used`);
  }
  log(`clock check vs ${origin}: skew=${skewText} ${facts} threshold=${clockSkewSeconds}s`);
}

/**
 * Default clockProbe: GET the issuing core's root with `Accept:
 * application/json` (same transport trust as the ack) and read
 * `meta.serverTime` (Unix seconds), falling back to the `Date` header.
 * The local time is the midpoint of the request. Resolves null when the
 * answer carries no server time; rejects on transport errors.
 */
function defaultClockProbe (originUrl: string, caCertPem: string): Promise<ClockProbeResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(originUrl);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options: Record<string, unknown> = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: { accept: 'application/json' }
    };
    if (isHttps) {
      if (caCertPem) options.ca = caCertPem;
      options.rejectUnauthorized = true;
    }
    const t0 = Date.now();
    const req = lib.request(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const t1 = Date.now();
        const timing = { rttMs: t1 - t0, localMs: Math.round((t0 + t1) / 2) };
        let serverTime: unknown = null;
        try { serverTime = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.meta?.serverTime; } catch { /* not JSON */ }
        if (typeof serverTime === 'number' && Number.isFinite(serverTime)) {
          return resolve({ serverTimeMs: Math.round(serverTime * 1000), ...timing });
        }
        const dateMs = Date.parse(String(res.headers.date ?? ''));
        if (Number.isFinite(dateMs)) return resolve({ serverTimeMs: dateMs, ...timing });
        resolve(null);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function resolvePassphrase ({ passphrase, passphraseFile }: { passphrase?: string; passphraseFile?: string }): string {
  if (typeof passphrase === 'string' && passphrase.length > 0) return passphrase;
  if (passphraseFile) {
    if (!fs.existsSync(passphraseFile)) {
      throw new Error(`consume: passphrase file not found at ${passphraseFile}`);
    }
    const raw = fs.readFileSync(passphraseFile, 'utf8');
    const cleaned = raw.replace(/\r?\n$/, '');
    if (cleaned.length === 0) {
      throw new Error('consume: passphrase file is empty');
    }
    return cleaned;
  }
  throw new Error('consume: pass --bootstrap-passphrase-file <path> or set passphrase');
}

/**
 * Default httpClient — POSTs JSON over HTTPS (or HTTP for dev) with the
 * bundled CA cert pinned. Resolves with `{ statusCode, body }`.
 */
function defaultHttpClient (url: string, payload: Record<string, unknown>, caCertPem: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const options: Record<string, unknown> = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length
      }
    };
    if (isHttps) {
      // Always verify the server cert. When a cluster CA is supplied we pin
      // it; otherwise (ack-trust-system-ca) we fall back to the system CA
      // store. rejectUnauthorized stays true in both cases.
      if (caCertPem) options.ca = caCertPem;
      options.rejectUnauthorized = true;
    }
    const req = lib.request(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        if (raw.length > 0) {
          try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// defaultHttpClient is exported so master.js can use it directly
export { consume, defaultHttpClient, defaultClockProbe };
