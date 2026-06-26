/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const {
  createBackupEncryptor, createBackupDecryptor,
  createFilesystemBackupWriter, createFilesystemBackupReader
} = require('../interfaces/backup/index.ts');

const MAGIC = Buffer.from('PRYVBKE1', 'utf8');

function rsaKeypair () {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

async function runStream (transform, input) {
  const out = [];
  await pipeline(Readable.from(input), transform, async function (source) {
    for await (const piece of source) out.push(Buffer.from(piece));
  });
  return Buffer.concat(out);
}

async function collectAttachment (stream) {
  const out = [];
  for await (const piece of stream) out.push(Buffer.from(piece));
  return Buffer.concat(out);
}

describe('[BENC] backup encryption', () => {
  // -------------------------------------------------------------------------
  // Cipher primitives
  // -------------------------------------------------------------------------
  describe('cipher', () => {
    it('[BC01] symmetric buffer round-trips', () => {
      const enc = createBackupEncryptor({ passphrase: 'correct horse' });
      const dec = createBackupDecryptor(enc.envelope, { passphrase: 'correct horse' });
      const plain = Buffer.from('the quick brown fox jumps over the lazy dog');
      const cipherBytes = enc.encryptBuffer(plain);
      assert.ok(cipherBytes.subarray(0, MAGIC.length).equals(MAGIC), 'starts with magic');
      assert.ok(!cipherBytes.includes(plain), 'plaintext not present in ciphertext');
      assert.deepStrictEqual(dec.decryptBuffer(cipherBytes), plain);
    });

    it('[BC02] hybrid (recipient pubkey) buffer round-trips and host holds no decrypt secret', () => {
      const { publicKey, privateKey } = rsaKeypair();
      const enc = createBackupEncryptor({ recipientPubKeyPem: publicKey });
      assert.strictEqual(enc.envelope.mode, 'hybrid');
      assert.ok(enc.envelope.wrappedKey, 'envelope carries the wrapped data key');
      // The envelope alone (what the backup host keeps) cannot decrypt.
      assert.throws(() => createBackupDecryptor(enc.envelope, {}), /private key required/);
      const dec = createBackupDecryptor(enc.envelope, { privateKeyPem: privateKey });
      const plain = Buffer.from(JSON.stringify({ phi: 'patient-data', n: 42 }));
      assert.deepStrictEqual(dec.decryptBuffer(enc.encryptBuffer(plain)), plain);
    });

    it('[BC03] multi-chunk stream round-trips (input larger than chunk)', async () => {
      const enc = createBackupEncryptor({ passphrase: 'pw', chunkSize: 1024 });
      const dec = createBackupDecryptor(enc.envelope, { passphrase: 'pw' });
      const plain = crypto.randomBytes(5000); // ~5 chunks + remainder
      const cipherBytes = await runStream(enc.encryptStream(), plain);
      assert.ok(cipherBytes.subarray(0, MAGIC.length).equals(MAGIC));
      const back = await runStream(dec.decryptStream(), cipherBytes);
      assert.deepStrictEqual(back, plain);
    });

    it('[BC04] empty input round-trips (header only, no frames)', () => {
      const enc = createBackupEncryptor({ passphrase: 'pw' });
      const dec = createBackupDecryptor(enc.envelope, { passphrase: 'pw' });
      assert.deepStrictEqual(dec.decryptBuffer(enc.encryptBuffer(Buffer.alloc(0))), Buffer.alloc(0));
    });

    it('[BC05] wrong passphrase fails authentication', () => {
      const enc = createBackupEncryptor({ passphrase: 'right' });
      const dec = createBackupDecryptor(enc.envelope, { passphrase: 'wrong' });
      assert.throws(() => dec.decryptBuffer(enc.encryptBuffer(Buffer.from('secret'))));
    });

    it('[BC06] tampered ciphertext fails the GCM auth tag', () => {
      const enc = createBackupEncryptor({ passphrase: 'pw' });
      const dec = createBackupDecryptor(enc.envelope, { passphrase: 'pw' });
      const cipherBytes = enc.encryptBuffer(Buffer.from('secret payload'));
      cipherBytes[cipherBytes.length - 1] ^= 0xff; // flip a byte in the last tag
      assert.throws(() => dec.decryptBuffer(cipherBytes));
    });
  });

  // -------------------------------------------------------------------------
  // Writer / Reader integration over a temp directory
  // -------------------------------------------------------------------------
  describe('writer/reader', () => {
    let tmp;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-backup-enc-')); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    const userId = 'u-0001';
    const username = 'alice';
    const streams = [{ id: 's1', name: 'Diary' }, { id: 's2', name: 'Health' }];
    const events = [{ id: 'e1', streamIds: ['s1'], type: 'note/txt', content: 'PLAINMARK_event' }];
    const account = { id: userId, username, email: 'alice@example.com' };
    const attachmentBytes = Buffer.from('PLAINMARK_attachment_binary_blob');

    async function writeBackup (encryptor) {
      const writer = createFilesystemBackupWriter(tmp, { compress: false, encryptor });
      const uw = await writer.openUser(userId, username);
      await uw.writeStreams(streams);
      await uw.writeEvents(events);
      await uw.writeAccountData(account);
      await uw.writeAttachment('e1', 'att-1', Readable.from(attachmentBytes));
      const userManifest = await uw.close();
      await writer.writeManifest({
        coreVersion: 'test',
        config: {},
        backupType: 'full',
        backupTimestamp: 1,
        userManifests: [userManifest]
      });
      await writer.close();
    }

    async function readBackup (decryptor) {
      const reader = createFilesystemBackupReader(tmp, { decryptor });
      const manifest = await reader.readManifest();
      const ur = await reader.openUser(userId);
      const gotStreams = [];
      for await (const s of ur.readStreams()) gotStreams.push(s);
      const gotEvents = [];
      for await (const e of ur.readEvents()) gotEvents.push(e);
      const gotAccount = await ur.readAccountData();
      let gotAttachment = null;
      for await (const a of ur.readAttachments()) gotAttachment = await collectAttachment(a.stream);
      await reader.close();
      return { manifest, gotStreams, gotEvents, gotAccount, gotAttachment };
    }

    it('[BC10] symmetric encrypted backup restores identical data', async () => {
      const enc = createBackupEncryptor({ passphrase: 'pw' });
      await writeBackup(enc);
      const dec = createBackupDecryptor(enc.envelope, { passphrase: 'pw' });
      const r = await readBackup(dec);
      assert.deepStrictEqual(r.gotStreams, streams);
      assert.deepStrictEqual(r.gotEvents, events);
      assert.deepStrictEqual(r.gotAccount, account);
      assert.deepStrictEqual(r.gotAttachment, attachmentBytes);
    });

    it('[BC11] no plaintext PHI/PII touches the disk', async () => {
      const enc = createBackupEncryptor({ passphrase: 'pw' });
      await writeBackup(enc);

      // encryption.json must exist, be valid JSON, and carry no user data.
      const envRaw = fs.readFileSync(path.join(tmp, 'encryption.json'), 'utf8');
      const envelope = JSON.parse(envRaw);
      assert.strictEqual(envelope.mode, 'symmetric');
      assert.ok(!envRaw.includes('alice') && !envRaw.includes('PLAINMARK'));

      // Every other file must be ciphertext: start with MAGIC, no plaintext markers.
      // The cleartext self-recovery artifacts are the only exceptions.
      const cleartext = new Set(['encryption.json', 'RESTORE-README.md', 'decrypt-backup.mjs']);
      const markers = ['PLAINMARK', 'alice@example.com', 'Diary', userId, username];
      const files = [];
      (function walk (dir) {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          if (fs.statSync(p).isDirectory()) walk(p);
          else if (!cleartext.has(name)) files.push(p);
        }
      })(tmp);
      assert.ok(files.length >= 5, 'wrote several files');
      for (const f of files) {
        const bytes = fs.readFileSync(f);
        assert.ok(bytes.subarray(0, MAGIC.length).equals(MAGIC), `${f} is encrypted (magic)`);
        const text = bytes.toString('latin1');
        for (const m of markers) {
          assert.ok(!text.includes(m), `${f} must not leak plaintext "${m}"`);
        }
      }
    });

    it('[BC12] hybrid encrypted backup restores via private key only', async () => {
      const { publicKey, privateKey } = rsaKeypair();
      const enc = createBackupEncryptor({ recipientPubKeyPem: publicKey });
      await writeBackup(enc);
      const dec = createBackupDecryptor(enc.envelope, { privateKeyPem: privateKey });
      const r = await readBackup(dec);
      assert.deepStrictEqual(r.gotStreams, streams);
      assert.deepStrictEqual(r.gotAttachment, attachmentBytes);
    });

    it('[BC13] no encryptor => plaintext passthrough, no envelope written', async () => {
      await writeBackup(null);
      assert.ok(!fs.existsSync(path.join(tmp, 'encryption.json')), 'no envelope for plaintext backup');
      const r = await readBackup(null);
      assert.deepStrictEqual(r.gotStreams, streams);
      assert.deepStrictEqual(r.gotAccount, account);
      assert.deepStrictEqual(r.gotAttachment, attachmentBytes);
    });

    it('[BC14] bundled decrypt-backup.mjs recovers the tree with no Pryv.io code', async () => {
      const { execFileSync } = require('node:child_process');
      const enc = createBackupEncryptor({ passphrase: 'pw' });
      await writeBackup(enc);

      // Both self-recovery artifacts must be shipped alongside the backup.
      assert.ok(fs.existsSync(path.join(tmp, 'decrypt-backup.mjs')), 'decrypt script shipped');
      assert.ok(fs.existsSync(path.join(tmp, 'RESTORE-README.md')), 'restore readme shipped');

      // Run the standalone script exactly as an operator would — only Node, no app.
      const outDir = path.join(tmp, 'plain');
      execFileSync(process.execPath, [
        path.join(tmp, 'decrypt-backup.mjs'), tmp, '--passphrase', 'pw', '--out', outDir
      ], { stdio: 'pipe' });

      // The decrypted mirror is plaintext (compress:false here) and matches.
      const streamsPlain = fs.readFileSync(path.join(outDir, 'users', userId, 'streams.jsonl'), 'utf8');
      const gotStreams = streamsPlain.trim().split('\n').map((l) => JSON.parse(l));
      assert.deepStrictEqual(gotStreams, streams);
      const attachPlain = fs.readFileSync(path.join(outDir, 'users', userId, 'attachments', 'att-1'));
      assert.deepStrictEqual(attachPlain, attachmentBytes);
    });
  });
});
