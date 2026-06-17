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
 *   3. applyBundle(...) — decrypt, validate, materialize override-config.yml
 *      and TLS files (see ./applyBundle.js).
 *   4. POST {coreId, token, tlsFingerprint} to the bundle's ackUrl, with the
 *      bundled CA cert pinned (`ca:` option on the https request) so we
 *      refuse to ack any TLS endpoint that isn't issued by the cluster CA.
 *      `trustSystemCa` drops the pin and verifies against the system CA
 *      store instead (for cores whose API origin is fronted by a public/ACME
 *      cert); the join token remains the authenticator.
 *   5. Delete the original bundle file on success — once acked, the bundle
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

interface ConsumeOpts {
  bundlePath: string;
  passphrase?: string;
  passphraseFile?: string;
  configDir: string;
  tlsDir: string;
  httpClient?: HttpClient;
  trustSystemCa?: boolean;
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
  const applied = await applyBundleMod.applyBundle({
    armoredBundle, passphrase: resolvedPassphrase, configDir, tlsDir
  });
  log(`Wrote ${applied.overridePath}`);
  log(`Wrote TLS files in ${tlsDir}`);

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
export { consume, defaultHttpClient };
