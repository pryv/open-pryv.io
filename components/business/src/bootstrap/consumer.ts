/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Plan 34 Phase 4c — bootstrap-mode driver for `bin/master.js --bootstrap`.
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

const applyBundleMod = require('./applyBundle');

/**
 * @param {Object} opts
 * @param {string} opts.bundlePath - path to the armored .json.age (or any name) file
 * @param {string} [opts.passphrase] - if given, used directly (test path)
 * @param {string} [opts.passphraseFile] - read from this file; trim trailing newlines
 * @param {string} opts.configDir
 * @param {string} opts.tlsDir
 * @param {Function} [opts.httpClient] - (url, body, caCertPem) => Promise<{ statusCode, body }>;
 *                                       defaults to a CA-pinned node https POST
 * @param {Function} [opts.log] - logger; default = console.log
 * @returns {Promise<{
 *   coreId: string,
 *   ackResponse: Object,
 *   overridePath: string,
 *   tlsPaths: Object,
 *   bundleDeleted: boolean
 * }>}
 */
async function consume (opts) {
  const {
    bundlePath, passphrase, passphraseFile, configDir, tlsDir,
    httpClient = defaultHttpClient,
    log = (m) => console.log('[bootstrap] ' + m)
  } = opts || {};

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

  log(`Acking to ${applied.ackUrl} ...`);
  const ackResponse = await httpClient(
    applied.ackUrl,
    {
      coreId: applied.coreId,
      token: applied.joinToken,
      tlsFingerprint: applied.tlsFingerprint
    },
    applied.bundle.cluster.ca.certPem
  );
  if (ackResponse.statusCode !== 200) {
    throw new Error(
      `ack failed: HTTP ${ackResponse.statusCode}: ` +
      JSON.stringify(ackResponse.body)
    );
  }
  log(`Ack accepted; cluster has ${ackResponse.body?.cluster?.cores?.length ?? '?'} core(s)`);

  let bundleDeleted = false;
  try {
    fs.unlinkSync(bundlePath);
    bundleDeleted = true;
    log(`Deleted bundle file ${bundlePath} (token has been burned).`);
  } catch (err) {
    log(`Warning: could not delete bundle file ${bundlePath}: ${err.message}`);
  }

  return {
    coreId: applied.coreId,
    ackResponse: ackResponse.body,
    overridePath: applied.overridePath,
    tlsPaths: applied.tlsPaths,
    bundleDeleted
  };
}

function resolvePassphrase ({ passphrase, passphraseFile }) {
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
function defaultHttpClient (url, payload, caCertPem) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const options: any = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length
      }
    };
    if (isHttps && caCertPem) {
      options.ca = caCertPem;
      options.rejectUnauthorized = true;
    }
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
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

module.exports = {
  consume,
  defaultHttpClient // exported so master.js can use it directly
};
