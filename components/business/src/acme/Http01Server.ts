/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Tiny HTTP server that serves
 *   GET /.well-known/acme-challenge/<token>
 * by looking the token up in an Http01ChallengeStore. Used to satisfy
 * LE's HTTP-01 validation flow:
 *
 *   1. CertRenewer.challengeCreateFn writes (token, keyAuthorization)
 *      into the store.
 *   2. acme-client tells LE "challenge ready".
 *   3. LE GETs http://<hostname>/.well-known/acme-challenge/<token>
 *   4. This server returns 200 + keyAuthorization (plain text).
 *   5. LE validates, acme-client gets the cert, challengeRemoveFn
 *      drops the token from the store.
 *
 * Bind directly to TCP/80. All other paths return 404 — open-pryv.io
 * never serves anything else on plain HTTP when letsEncrypt.enabled
 * is on (TLS lives on :443).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// Type-only import is fine via the same relative path (no runtime require).
import type { Http01ChallengeStore } from './Http01ChallengeStore.ts';

type LogFn = (msg: string) => void;

const ACME_PATH_RE = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)\/?$/;

interface Http01ServerOpts {
  store: Http01ChallengeStore;
  port?: number; // default 80
  host?: string; // default '0.0.0.0'
  log?: LogFn;
}

/**
 * Build (but don't yet start) an HTTP-01 challenge server.
 *
 * Call `.listen()` to bind. Call `.close()` to release the port.
 */
export function createHttp01Server (opts: Http01ServerOpts): http.Server & { listenAsync: () => Promise<AddressInfo>; closeAsync: () => Promise<void> } {
  const { store, port = 80, host = '0.0.0.0', log = () => {} } = opts;

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const m = req.method === 'GET' ? ACME_PATH_RE.exec(url) : null;
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found\n');
      return;
    }
    const token = m[1];
    const ka = store.get(token);
    if (!ka) {
      // The token is unknown — either LE is hitting us after challengeRemoveFn
      // already cleared it, or someone is poking the endpoint. Log it once at
      // info-level so operators can correlate during issuance.
      log(`http-01: GET .../${token} — token not in store (404)`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(ka);
    log(`http-01: GET .../${token} — served ${ka.length} bytes`);
  });

  // Augment the plain http.Server with the promised helpers declared in the
  // return type — single cast, properties attached right below.
  const augmented = server as http.Server & { listenAsync: () => Promise<AddressInfo>; closeAsync: () => Promise<void> };

  augmented.listenAsync = function listenAsync (): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address() as AddressInfo);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  };

  augmented.closeAsync = function closeAsync (): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  };

  return augmented;
}
