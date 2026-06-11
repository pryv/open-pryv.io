/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Watch PlatformDB for a certificate's rotation, materialize it on local
 * disk, and notify in-process http servers + (optionally) an
 * operator-supplied external reload script.
 *
 * Every core runs this loop (renewer or not). When the CA-holder core
 * renews a cert, rqlite replicates the new row into every core's local
 * rqlite snapshot; each core's materializer picks up the change on its
 * next tick and:
 *   1. Decrypts the keyPem via CertRenewer.getCertificate.
 *   2. Writes {tlsDir}/{hostnameDir}/fullchain.pem + privkey.pem (0600
 *      on the key file).
 *   3. Calls onRotate(certPath, keyPath, hostname) — used by master.js
 *      to hot-swap the server's TLS context (https.Server.setSecureContext)
 *      AND to spawn letsEncrypt.onRotateScript if configured.
 *
 * Pure: no scheduling here — the caller drives the `checkOnce()` tick
 * via setInterval or whatever scheduler fits. Detection is by SHA-256
 * fingerprint: the on-disk cert is hashed and compared to the incoming
 * one; no state is kept in memory.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { hostnameToDirName } = require('./certUtils.ts');

type CertRecord = { certPem: string; chainPem?: string; keyPem: string; expiresAt: number };
type CertRenewer = { getCertificate (hostname: string): Promise<CertRecord | null> };
type OnRotateFn = (certPath: string, keyPath: string, hostname: string) => Promise<unknown>;
type LogLine = (msg: string) => void;
type WriteOpts = { mode?: number; [k: string]: unknown };

class FileMaterializer {
  #certRenewer: CertRenewer;
  #tlsDir: string;
  #hostname: string;
  #onRotate: OnRotateFn;
  #log: LogLine;

  /**
   * @param opts.certRenewer  - exposes getCertificate(hostname) returning decrypted record
   * @param opts.tlsDir       - root dir; certs go in <tlsDir>/<normalised-host>/
   * @param opts.hostname     - which hostname this core cares about (e.g. '*.mc.example.com')
   * @param [opts.onRotate] - (certPath, keyPath, hostname) => Promise; called after a successful swap
   * @param [opts.log]      - default: console.log
   */
  constructor ({ certRenewer, tlsDir, hostname, onRotate, log }: { certRenewer?: CertRenewer; tlsDir?: string; hostname?: string; onRotate?: OnRotateFn; log?: LogLine } = {}) {
    if (certRenewer == null) throw new Error('FileMaterializer: certRenewer is required');
    if (!tlsDir) throw new Error('FileMaterializer: tlsDir is required');
    if (!hostname) throw new Error('FileMaterializer: hostname is required');
    this.#certRenewer = certRenewer;
    this.#tlsDir = tlsDir;
    this.#hostname = hostname;
    this.#onRotate = onRotate || (async () => {});
    this.#log = log || ((msg: string) => console.log('[fm] ' + msg));
  }

  get hostDir () {
    return path.join(this.#tlsDir, hostnameToDirName(this.#hostname));
  }

  get certPath () { return path.join(this.hostDir, 'fullchain.pem'); }
  get keyPath () { return path.join(this.hostDir, 'privkey.pem'); }

  /**
   * Pull the current cert from PlatformDB. If it differs from what's on
   * disk (or there's nothing on disk), write it and invoke onRotate.
   * Returns `{ rotated: boolean, reason?: string }` so the caller can
   * log / telemeter.
   */
  async checkOnce () {
    const cert = await this.#certRenewer.getCertificate(this.#hostname);
    if (cert == null) {
      return { rotated: false, reason: 'no-cert-in-platformdb' };
    }

    const incoming = (cert.certPem || '') + (cert.chainPem || '');
    const onDisk = this.#readIfExists(this.certPath);
    if (onDisk != null && sha256(onDisk) === sha256(incoming)) {
      return { rotated: false, reason: 'unchanged' };
    }

    fs.mkdirSync(this.hostDir, { recursive: true });
    writeAtomic(this.certPath, incoming, { mode: 0o644 });
    writeAtomic(this.keyPath, cert.keyPem, { mode: 0o600 });
    this.#log(`rotated ${this.#hostname} (expires ${new Date(cert.expiresAt).toISOString()})`);

    try {
      await this.#onRotate(this.certPath, this.keyPath, this.#hostname);
    } catch (err: unknown) {
      // onRotate failure is the operator's concern — surface it but don't
      // undo the file write (the new cert is valid either way).
      this.#log(`onRotate hook failed: ${(err as Error).message}`);
    }

    return { rotated: true, reason: onDisk == null ? 'initial-write' : 'cert-changed' };
  }

  #readIfExists (p: string): string | null {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  }
}

function writeAtomic (filePath: string, content: string, opts: WriteOpts = {}) {
  const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, content, opts);
  fs.renameSync(tmp, filePath);
}

function sha256 (s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Spawn `scriptPath` with env vars the operator can consume. Returns
 * { exitCode, stdout, stderr, durationMs }. Non-zero exits do NOT
 * throw — the caller logs and moves on (script-failure is non-fatal).
 *
 * @param opts.scriptPath
 * @param opts.hostname
 * @param opts.certPath
 * @param opts.keyPath
 * @param [opts.timeoutMs=30000]
 */
async function runRotateScript ({ scriptPath, hostname, certPath, keyPath, timeoutMs = 30000 }: { scriptPath: string; hostname: string; certPath: string; keyPath: string; timeoutMs?: number }) {
  const { spawn } = require('node:child_process');
  if (!path.isAbsolute(scriptPath)) {
    throw new Error(`onRotateScript must be an absolute path, got ${scriptPath}`);
  }
  const started = Date.now();
  const child = spawn(scriptPath, [], {
    env: {
      ...process.env,
      PRYV_CERT_HOSTNAME: hostname,
      PRYV_CERT_PATH: certPath,
      PRYV_CERT_KEYPATH: keyPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdout.push(c));
  child.stderr.on('data', (c: Buffer) => stderr.push(c));

  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const exitCode = await new Promise<number>(resolve => {
    child.on('close', (code: number | null, signal: string | null) => resolve(signal === 'SIGKILL' ? 124 : (code ?? 0)));
    child.on('error', () => resolve(127));
  });
  clearTimeout(timer);

  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    durationMs: Date.now() - started
  };
}

export { FileMaterializer, runRotateScript };