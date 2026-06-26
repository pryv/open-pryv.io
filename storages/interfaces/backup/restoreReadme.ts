/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Self-recovery artifacts written alongside an encrypted backup.
 *
 * The goal of encrypted backups is that the holder of the key can always get
 * the data back — even on a machine that does not have Pryv.io installed. So
 * every encrypted backup ships two extra cleartext files at its root:
 *
 *   - `decrypt-backup.mjs` — a zero-dependency Node script (stdlib `crypto`
 *     only) that decrypts the whole tree into a plaintext mirror. It is a
 *     faithful, standalone re-implementation of the wire format so it does not
 *     need this codebase.
 *   - `RESTORE-README.md` — human instructions for both restore paths (the full
 *     `bin/backup.js --restore` tool and the standalone decrypter).
 *
 * `decrypt-backup.mjs` is verified end-to-end by the test suite (it is executed
 * against a real encrypted backup), so it cannot silently drift from the cipher.
 */

const RESTORE_README_NAME = 'RESTORE-README.md';
const DECRYPT_SCRIPT_NAME = 'decrypt-backup.mjs';

/**
 * Standalone, dependency-free decrypter. Mirrors the BackupCipher wire format.
 * Kept free of backticks and ${...} so it can live inside this template literal.
 */
const STANDALONE_DECRYPT_SCRIPT = `#!/usr/bin/env node
// Standalone decrypter for an encrypted Pryv.io backup.
//
// Zero dependencies — Node.js stdlib only. Works without Pryv.io installed.
//
// Usage (run from the backup directory, or pass it as the first argument):
//   node decrypt-backup.mjs --private-key /path/to/private.pem [--out DIR]
//   node decrypt-backup.mjs --passphrase 'your-passphrase'     [--out DIR]
//   PRYV_BACKUP_PASSPHRASE=... node decrypt-backup.mjs          [--out DIR]
//
// Writes a plaintext mirror of the backup tree to --out (default: <dir>-decrypted).
// The plaintext files are JSONL (optionally gzip-compressed, *.jsonl.gz) plus
// raw attachment blobs, exactly as an unencrypted backup would contain.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAGIC = Buffer.from('PRYVBKE1', 'utf8');
const TAG = 16;
const NONCE = 12;
const KEY = 32;
const HKDF_INFO = Buffer.from('pryv-backup-file-v1', 'utf8');
const SKIP = new Set(['encryption.json', 'RESTORE-README.md', 'decrypt-backup.mjs']);

function fail (msg) { console.error('Error: ' + msg); process.exit(1); }

function parseArgs (argv) {
  const a = { dir: null, privateKey: null, privateKeyPassphrase: null, passphrase: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--private-key') a.privateKey = argv[++i];
    else if (v === '--private-key-passphrase') a.privateKeyPassphrase = argv[++i];
    else if (v === '--passphrase') a.passphrase = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (!v.startsWith('-')) a.dir = v;
  }
  if (a.dir === null) a.dir = '.';
  if (a.passphrase === null) a.passphrase = process.env.PRYV_BACKUP_PASSPHRASE || null;
  return a;
}

function counterNonce (i) {
  const b = Buffer.alloc(NONCE);
  b.writeUInt32BE(Math.floor(i / 0x100000000), NONCE - 8);
  b.writeUInt32BE(i >>> 0, NONCE - 4);
  return b;
}

function deriveFileKey (dataKey, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', dataKey, salt, HKDF_INFO, KEY));
}

function resolveDataKey (envelope, args) {
  if (envelope.mode === 'hybrid') {
    if (!args.privateKey) fail('this backup is hybrid-encrypted; pass --private-key <pem>');
    const pem = fs.readFileSync(args.privateKey, 'utf8');
    return crypto.privateDecrypt(
      { key: pem, oaepHash: 'sha256', passphrase: args.privateKeyPassphrase || undefined },
      Buffer.from(envelope.wrappedKey, 'base64')
    );
  }
  if (envelope.mode === 'symmetric') {
    if (!args.passphrase) fail('this backup is passphrase-encrypted; pass --passphrase or set PRYV_BACKUP_PASSPHRASE');
    return crypto.scryptSync(args.passphrase, Buffer.from(envelope.salt, 'base64'), KEY,
      { N: envelope.N, r: envelope.r, p: envelope.p });
  }
  fail('unknown encryption mode: ' + envelope.mode);
}

function decryptFile (dataKey, full) {
  if (full.length < MAGIC.length + 4 || !full.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an encrypted backup file (bad magic)');
  }
  const headerLen = full.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLen;
  const header = JSON.parse(full.subarray(headerStart, headerEnd).toString('utf8'));
  const fileKey = deriveFileKey(dataKey, Buffer.from(header.salt, 'base64'));
  const out = [];
  let off = headerEnd;
  let idx = 0;
  while (off < full.length) {
    const len = full.readUInt32BE(off);
    off += 4;
    const payload = full.subarray(off, off + len);
    off += len;
    const ct = payload.subarray(0, payload.length - TAG);
    const tag = payload.subarray(payload.length - TAG);
    const d = crypto.createDecipheriv('aes-256-gcm', fileKey, counterNonce(idx++));
    d.setAuthTag(tag);
    out.push(Buffer.concat([d.update(ct), d.final()]));
  }
  return Buffer.concat(out);
}

function walk (dir, base, files) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(base, p);
    if (fs.statSync(p).isDirectory()) walk(p, base, files);
    else if (!SKIP.has(rel)) files.push(rel);
  }
  return files;
}

function main () {
  const args = parseArgs(process.argv.slice(2));
  const envPath = path.join(args.dir, 'encryption.json');
  if (!fs.existsSync(envPath)) fail('no encryption.json found in ' + args.dir + ' (not an encrypted backup?)');
  const envelope = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  const dataKey = resolveDataKey(envelope, args);
  const outDir = args.out || (path.resolve(args.dir) + '-decrypted');

  const files = walk(args.dir, args.dir, []);
  let n = 0;
  for (const rel of files) {
    const plain = decryptFile(dataKey, fs.readFileSync(path.join(args.dir, rel)));
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, plain);
    n++;
  }
  console.log('Decrypted ' + n + ' file(s) to ' + outDir);
}

main();
`;

/** Build the human-facing restore instructions for a given envelope. */
function buildRestoreReadme (envelope: Record<string, unknown>): string {
  const isHybrid = envelope.mode === 'hybrid';
  const secretLine = isHybrid
    ? '- **Key:** the RSA **private key** matching the public key used to create this backup.'
    : '- **Key:** the **passphrase** used to create this backup.';
  const toolFlag = isHybrid
    ? '--private-key /path/to/private.pem'
    : "--decrypt-passphrase 'your-passphrase'";
  const standaloneFlag = isHybrid
    ? '--private-key /path/to/private.pem'
    : "--passphrase 'your-passphrase'";

  return [
    '# Restoring this encrypted backup',
    '',
    'This backup is **encrypted** (' + String(envelope.mode) + ', ' + String(envelope.alg) + ').',
    'Every data file is ciphertext; the cleartext `encryption.json` here holds only',
    'the crypto headers and the wrapped data key — no user data.',
    '',
    secretLine,
    '',
    '> **Without the key the data is unrecoverable.** Keep it safe and separate from the backup media.',
    '',
    '## Option A — restore into a Pryv.io platform',
    '',
    'With Pryv.io available, restore directly (it auto-detects the encryption):',
    '',
    '```bash',
    'node bin/backup.js --restore /path/to/this-backup ' + toolFlag,
    '```',
    '',
    '## Option B — just decrypt the files (no Pryv.io needed)',
    '',
    'The bundled `decrypt-backup.mjs` is a zero-dependency Node script that decrypts',
    'the whole tree into a plaintext mirror. Run it from this directory:',
    '',
    '```bash',
    'node decrypt-backup.mjs ' + standaloneFlag + ' --out /path/to/plaintext',
    '```',
    '',
    'The output is plaintext JSONL (optionally gzip-compressed `*.jsonl.gz`) plus raw',
    'attachment blobs — the same layout an unencrypted backup would have.',
    ''
  ].join('\n');
}

export { STANDALONE_DECRYPT_SCRIPT, buildRestoreReadme, RESTORE_README_NAME, DECRYPT_SCRIPT_NAME };
