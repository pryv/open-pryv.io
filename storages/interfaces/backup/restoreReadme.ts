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
 * every encrypted backup ships two extra cleartext files at its root (and each
 * incremental run of a chain, in its own directory):
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
// Writes a plaintext mirror of the backup tree to --out (default: <dir>-decrypted;
// for a run directory decrypted alone, <backup dir>-<runId>-decrypted).
// The plaintext files are JSONL (optionally gzip-compressed, *.jsonl.gz) plus
// raw attachment blobs, exactly as an unencrypted backup would contain.
//
// A backup chain (a full backup plus incremental runs, listed by chain.json)
// is decrypted whole: each run (the root, and every incrementals/<runId>/)
// with its own encryption.json. The mirror keeps the tree and a plaintext
// chain.json, so it can be restored as a plaintext chain. Run from a run
// directory (incrementals/<runId>), the script decrypts the whole chain at
// its root, two levels up; a run directory copied out of its chain is
// decrypted alone.
//
// Integrity: each run's manifest lists every file of the run with its size
// and hash (runs written by earlier releases list none). The manifest is
// decrypted first; a file added, missing, resized or changed, or cut short,
// stops the script with the file named (the files already written stay).
// --ignore-damaged writes every file that verifies, lists the others and
// exits 1. The mirror's manifests carry no file list: the mirror restores as
// a backup written before file lists. --signing-pubkey <pem>: every run must
// carry a manifest.sig of that Ed25519 key (the backup was signed with
// --signing-key); manifest.sig is not copied to the mirror.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAGIC = Buffer.from('PRYVBKE1', 'utf8');
const TAG = 16;
const NONCE = 12;
const KEY = 32;
const HKDF_INFO = Buffer.from('pryv-backup-file-v1', 'utf8');
const SKIP = new Set(['encryption.json', 'chain.json', 'RESTORE-README.md', 'decrypt-backup.mjs']);

function fail (msg) { console.error('Error: ' + msg); process.exit(1); }

function parseArgs (argv) {
  const a = { dir: null, privateKey: null, privateKeyPassphrase: null, passphrase: null, out: null, ignoreDamaged: false, signingPubKey: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--ignore-damaged') a.ignoreDamaged = true;
    else if (v === '--signing-pubkey') a.signingPubKey = argv[++i];
    else if (v === '--private-key') a.privateKey = argv[++i];
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
      { N: envelope.N, r: envelope.r, p: envelope.p, maxmem: 256 * 1024 * 1024 });
  }
  fail('unknown encryption mode: ' + envelope.mode);
}

// Authenticated data of frame i of a format-2 file: the header digest, the
// frame index (8 bytes) and a final flag.
function frameAad (digest, i, final) {
  const b = Buffer.alloc(9);
  b.writeUInt32BE(Math.floor(i / 0x100000000), 0);
  b.writeUInt32BE(i >>> 0, 4);
  b[8] = final ? 1 : 0;
  return Buffer.concat([digest, b]);
}

function openFrame (fileKey, i, payload, aad) {
  if (payload.length < TAG) throw new Error('truncated chunk');
  const d = crypto.createDecipheriv('aes-256-gcm', fileKey, counterNonce(i), { authTagLength: TAG });
  if (aad) d.setAAD(aad);
  d.setAuthTag(payload.subarray(payload.length - TAG));
  return Buffer.concat([d.update(payload.subarray(0, payload.length - TAG)), d.final()]);
}

// Decrypt one file. Format 2 (the header names the file, its run and chain;
// every frame is bound to the header and its position; the last frame is
// flagged final): the identity must be the one expected, and a file cut short
// or extended is refused. Format 1 (earlier releases) is read as it is.
function decryptFile (dataKey, full, expect) {
  if (full.length < MAGIC.length + 4 || !full.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an encrypted backup file (bad magic)');
  }
  const headerLen = full.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLen;
  if (full.length < headerEnd) throw new Error('truncated encrypted file (header)');
  const header = JSON.parse(full.subarray(headerStart, headerEnd).toString('utf8'));
  if (header.v !== 1 && header.v !== 2) throw new Error('unsupported file format version ' + header.v);
  if (header.v === 2 && expect != null) {
    const other = header.path !== expect.path || header.run !== expect.runId ||
      (expect.chainId !== undefined && header.chain !== expect.chainId);
    if (other) throw new Error('carries the identity of ' + header.path + ' (run ' + header.run + '): refused');
  }
  const digest = header.v === 2 ? crypto.createHash('sha256').update(full.subarray(0, headerEnd)).digest() : null;
  const fileKey = deriveFileKey(dataKey, Buffer.from(header.salt, 'base64'));
  const out = [];
  let off = headerEnd;
  let idx = 0;
  let final = false;
  while (off < full.length) {
    if (final) throw new Error('data after the final frame');
    if (off + 4 > full.length) throw new Error('truncated chunk');
    const len = full.readUInt32BE(off);
    off += 4;
    if (off + len > full.length) throw new Error('truncated chunk');
    const payload = full.subarray(off, off + len);
    off += len;
    if (digest == null) {
      out.push(openFrame(fileKey, idx++, payload, null));
      continue;
    }
    try {
      out.push(openFrame(fileKey, idx, payload, frameAad(digest, idx, false)));
    } catch (e) {
      try {
        out.push(openFrame(fileKey, idx, payload, frameAad(digest, idx, true)));
        final = true;
      } catch (e2) {
        throw new Error('authentication failed (frame ' + idx + '): wrong key, or the file was altered');
      }
    }
    idx++;
  }
  if (digest != null && !final) throw new Error('truncated encrypted file (no final frame)');
  return Buffer.concat(out);
}

function walk (dir, base, files) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(base, p);
    if (fs.statSync(p).isDirectory()) walk(p, base, files);
    else files.push(rel);
  }
  return files;
}

// The run root of a file: the nearest ancestor, among the backup root and
// incrementals/<runId>, that holds an encryption.json.
function runRootOf (dir, rel) {
  const parts = rel.split(path.sep);
  if (parts[0] === 'incrementals' && parts.length > 2) {
    const runRoot = path.join(parts[0], parts[1]);
    if (fs.existsSync(path.join(dir, runRoot, 'encryption.json'))) return runRoot;
  }
  return '.';
}

// A run directory of a chain stands for the chain: its root (two levels up,
// where chain.json is) is decrypted, so the mirror lands next to the chain and
// never inside incrementals/. A run directory without its chain is decrypted
// alone; its default mirror goes next to the directory holding incrementals/
// (<that directory>-<runId>-decrypted), not inside it: plaintext never lands
// in an encrypted backup.
function resolveBackupDir (dir) {
  const abs = path.resolve(dir);
  const parent = path.dirname(abs);
  if (path.basename(parent) !== 'incrementals' || fs.existsSync(path.join(abs, 'chain.json'))) return { dir, defaultOut: abs + '-decrypted' };
  const root = path.dirname(parent);
  if (fs.existsSync(path.join(root, 'chain.json'))) {
    console.log('Run directory given: decrypting the whole chain at ' + root);
    return { dir: root, defaultOut: root + '-decrypted' };
  }
  console.log('Decrypting this run alone (no chain.json at ' + root + "); pass the chain's root directory to decrypt the whole chain");
  return { dir, defaultOut: root + '-' + path.basename(abs) + '-decrypted' };
}

function writePrivate (dest, data) {
  // Plaintext account data: for the owner only.
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, data, { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
}

function main () {
  const args = parseArgs(process.argv.slice(2));
  const resolved = resolveBackupDir(args.dir);
  args.dir = resolved.dir;
  const envPath = path.join(args.dir, 'encryption.json');
  if (!fs.existsSync(envPath)) fail('no encryption.json found in ' + args.dir + ' (not an encrypted backup?)');
  const outDir = args.out || resolved.defaultOut;

  // One data key per run, resolved once (the same passphrase or private key).
  const dataKeys = new Map();
  function dataKeyOf (runRoot) {
    const p = path.join(args.dir, runRoot, 'encryption.json');
    if (!dataKeys.has(p)) dataKeys.set(p, resolveDataKey(JSON.parse(fs.readFileSync(p, 'utf8')), args));
    return dataKeys.get(p);
  }

  // The identity every file must carry: its path relative to its run, the run
  // id ("full" at the root) and the chain id (chain.json; none for a backup
  // written outside a chain, unknown for a run decrypted alone).
  const chainPath = path.join(args.dir, 'chain.json');
  const chainInfo = fs.existsSync(chainPath) ? JSON.parse(fs.readFileSync(chainPath, 'utf8')) : null;
  const alone = chainInfo == null && path.basename(path.dirname(path.resolve(args.dir))) === 'incrementals';
  function expectOf (runRoot, rel) {
    const relInRun = path.relative(runRoot, rel).split(path.sep).join('/');
    if (alone) return { path: relInRun, runId: path.basename(path.resolve(args.dir)), chainId: undefined };
    const runId = runRoot === '.' ? 'full' : path.basename(runRoot);
    let chainId = null;
    if (chainInfo != null) chainId = runRoot === '.' && chainInfo.runs[0] && chainInfo.runs[0].bootstrapped === true ? null : chainInfo.chainId;
    return { path: relInRun, runId, chainId };
  }

  // The public key that must have signed every run (--signing-pubkey).
  let signingPubKey = null;
  if (args.signingPubKey) {
    signingPubKey = crypto.createPublicKey(fs.readFileSync(args.signingPubKey, 'utf8'));
    if (signingPubKey.asymmetricKeyType !== 'ed25519') fail('--signing-pubkey: not an Ed25519 public key');
  }
  const signingFingerprint = signingPubKey == null ? null
    : 'sha256:' + crypto.createHash('sha256').update(signingPubKey.export({ type: 'spki', format: 'der' })).digest('hex');
  // Why a run's signature does not verify, or null when it does.
  function verifySignature (runRoot, manifestRel, manifest, runLabel) {
    const sigPath = path.join(args.dir, runRoot, 'manifest.sig');
    if (manifest == null) return 'its manifest cannot be read';
    if (!fs.existsSync(sigPath)) return 'no manifest.sig';
    let sig;
    try { sig = JSON.parse(fs.readFileSync(sigPath, 'utf8')); } catch (e) { return 'manifest.sig is not JSON'; }
    if (sig.v !== 2 || sig.alg !== 'ed25519') return 'unknown signature format';
    if (sig.keyFingerprint !== signingFingerprint) return 'signed with another key (' + sig.keyFingerprint + ')';
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(args.dir, manifestRel))).digest('hex');
    if (sig.manifestSha256 !== digest) return 'manifest.json differs from the signed one';
    const message = Buffer.from('pryv-backup-manifest-v2\\n' + (manifest.chainId || '') + '\\n' + runLabel + '\\n' + digest, 'utf8');
    let ok = false;
    try { ok = crypto.verify(null, message, signingPubKey, Buffer.from(String(sig.signature), 'base64')); } catch (e) { ok = false; }
    return ok ? null : 'the signature does not verify';
  }

  // A damaged file stops the script (the files already written stay), or,
  // with --ignore-damaged, is skipped and listed at the end.
  const damaged = [];
  function damage (rel, msg) {
    if (!args.ignoreDamaged) fail(rel + ': ' + msg);
    damaged.push(rel + ': ' + msg);
  }
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

  // The files of each run, by run root.
  const byRun = new Map();
  for (const rel of walk(args.dir, args.dir, [])) {
    const runRoot = runRootOf(args.dir, rel);
    if (!byRun.has(runRoot)) byRun.set(runRoot, []);
    byRun.get(runRoot).push(rel);
  }
  let n = 0;
  for (const [runRoot, rels] of byRun) {
    const runLabel = alone ? path.basename(path.resolve(args.dir)) : (runRoot === '.' ? 'full' : path.basename(runRoot));
    const inRun = (rel) => path.relative(runRoot, rel).split(path.sep).join('/');
    // Not files of the run: its manifest and signature (read apart), and at
    // the root the chain's own files and the incrementals/ tree.
    const outsideTable = (p) => p === 'manifest.json' || p === 'manifest.sig' ||
      (runRoot === '.' && (p === 'chain.json' || p === '.chain.lock' || p.startsWith('.chain.json.') || p.startsWith('incrementals/')));

    // The manifest first: its file table says what the run holds.
    const manifestRel = path.join(runRoot, 'manifest.json');
    let manifest = null;
    if (rels.includes(manifestRel)) {
      try {
        manifest = JSON.parse(decryptFile(dataKeyOf(runRoot), fs.readFileSync(path.join(args.dir, manifestRel)), expectOf(runRoot, manifestRel)).toString('utf8'));
      } catch (err) {
        damage(manifestRel, err.message);
      }
    }
    // --signing-pubkey: the run must be signed by that key, over its manifest as written.
    if (signingPubKey != null) {
      const why = verifySignature(runRoot, manifestRel, manifest, runLabel);
      if (why != null) {
        damage(path.join(runRoot, 'manifest.sig'), 'not signed by the key given (--signing-pubkey): ' + why);
        continue;
      }
    }
    let table = null;
    if (manifest != null && manifest.integrity != null) {
      table = new Map((manifest.integrity.files || []).map((f) => [f.path, f]));
      const present = new Set();
      for (const rel of rels) {
        const p = inRun(rel);
        if (outsideTable(p)) continue;
        present.add(p);
        const listed = table.get(p);
        if (listed == null) damage(rel, 'unlisted file (not in the run\\'s manifest)');
        else if (fs.statSync(path.join(args.dir, rel)).size !== listed.size) damage(rel, 'size differs from the run\\'s manifest');
      }
      for (const p of table.keys()) {
        if (!present.has(p)) damage(path.join(runRoot, p), 'missing file (listed by the run\\'s manifest)');
      }
    }

    let verified = 0;
    for (const rel of rels) {
      const p = inRun(rel);
      if (outsideTable(p)) continue;
      const raw = fs.readFileSync(path.join(args.dir, rel));
      if (table != null) {
        const listed = table.get(p);
        if (listed == null || raw.length !== listed.size) continue; // reported above
        if (sha256(raw) !== listed.sha256) { damage(rel, 'differs from the run\\'s manifest (hash)'); continue; }
        verified++;
      }
      // Cleartext files of the run (checked above, not copied).
      if (SKIP.has(p)) continue;
      let plain;
      try {
        plain = decryptFile(dataKeyOf(runRoot), raw, expectOf(runRoot, rel));
      } catch (err) {
        damage(rel, err.message);
        continue;
      }
      writePrivate(path.join(outDir, rel), plain);
      n++;
    }
    if (manifest != null) {
      // The mirror's sizes and hashes are not the backup's: its manifest
      // carries no file table (it restores as a run without one).
      delete manifest.integrity;
      writePrivate(path.join(outDir, manifestRel), JSON.stringify(manifest, null, 2));
      n++;
    }
    if (table != null) console.log('Run ' + runLabel + ': ' + verified + ' files verified');
  }
  // The mirror of a chain is a plaintext chain.
  if (chainInfo != null) {
    const chain = chainInfo;
    chain.encryption = null;
    writePrivate(path.join(outDir, 'chain.json'), JSON.stringify(chain, null, 2));
    console.log('Backup chain: ' + chain.runs.length + ' run(s)');
  }
  console.log('Decrypted ' + n + ' file(s) to ' + outDir);
  if (damaged.length > 0) {
    console.error('Damaged, not written (' + damaged.length + '):');
    for (const d of damaged) console.error('  ' + d);
    process.exit(1);
  }
}

main();
`;

/**
 * Build the human-facing restore instructions for a given envelope. With
 * `runId`, the instructions of an incremental run's directory: they open by
 * saying where the chain root is.
 */
function buildRestoreReadme (envelope: Record<string, unknown>, options: { runId?: string } = {}): string {
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

  const runIntro = options.runId == null
    ? []
    : [
        'This directory is run `' + options.runId + '` of a backup chain. Its root is two levels up',
        '(`../..`); the restore tool and this script work on the root. Run `node decrypt-backup.mjs` from',
        'here without argument: it finds the root itself.',
        ''
      ];

  return [
    '# Restoring this encrypted backup',
    '',
    ...runIntro,
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
    '',
    '## Incremental chain',
    '',
    'When incremental backups (`--incremental`) were written into this directory, it holds',
    'a chain of runs: the full backup at this root, and each incremental run in its own',
    '`incrementals/<runId>/` directory. The cleartext `chain.json` lists the runs in order',
    '(run ids, snapshot times, user ids, key model). Each incremental run has its own',
    '`encryption.json` (its own data key), under the SAME ' + (isHybrid ? 'recipient key pair' : 'passphrase') + '.',
    '',
    '- `--restore` applies the whole chain: the full backup, then every incremental run in',
    '  order (a newer version of a stream, access, event or attachment replaces the older',
    '  one; deletions included). `--through-run <runId>` restores the state as of that run.',
    '- `node bin/backup.js --inspect /path/to/this-backup` lists the runs and says whether',
    '  the chain is sound.',
    '- `decrypt-backup.mjs` decrypts every run with its own `encryption.json` and writes the',
    '  plaintext mirror with the same tree and a plaintext `chain.json`, which `--restore`',
    '  reads as a plaintext chain. Each run carries its own copy: use the one of the newest',
    '  run (run from a run directory, it decrypts the whole chain at the root). A full backup',
    '  taken before 2.0.0-rc.51 keeps an older script at its root, which does not know',
    '  incremental runs.',
    ''
  ].join('\n');
}

export { STANDALONE_DECRYPT_SCRIPT, buildRestoreReadme, RESTORE_README_NAME, DECRYPT_SCRIPT_NAME };
