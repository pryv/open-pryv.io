/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Backup chain: a full backup and the incremental runs that follow it.
 *
 * A backup directory holds one chain. The full run keeps the layout of every
 * full backup, at the root; each incremental run writes ONLY under its own
 * `incrementals/<runId>/` directory (its manifest, its `encryption.json`, its
 * delta per user), so no run ever opens a file of another run for writing.
 * `chain.json` at the root (cleartext, written last, replaced atomically)
 * lists the runs in order. A directory without `chain.json` is a full backup
 * written before chains existed: one run at the root.
 *
 * Restore applies the runs in chain order, a newer version of an item
 * replacing the older one (a deletion is a newer version with `deleted` set).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { KeyObject, PrivateKeyInput, PublicKeyInput } from 'node:crypto';
import { createBackupDecryptor, recipientKeyFingerprint } from './BackupCipher.ts';
import type { BackupDecryptor, DecryptorSecrets, DecryptExpectation, Envelope } from './BackupCipher.ts';

const CHAIN_FILE_NAME = 'chain.json';
const INCREMENTALS_DIR_NAME = 'incrementals';
const MANIFEST_FILE_NAME = 'manifest.json';
const ENVELOPE_FILE_NAME = 'encryption.json';
const FULL_RUN_ID = 'full';
const CHAIN_FORMAT_VERSION = 1;
/** The first release that writes backup chains (named in the operator messages). */
const CHAIN_RELEASE = '2.0.0-rc.51';
/** The first release whose runs list their files in the manifest (named in the operator messages). */
const INTEGRITY_RELEASE = '2.0.0-rc.85';
/** Version of the `integrity` object of a run's manifest. */
const INTEGRITY_VERSION = 2;
/** Files at the root of a backup that belong to no run (the chain's own files). */
const ROOT_NON_RUN_FILES = new Set([CHAIN_FILE_NAME, '.chain.lock', INCREMENTALS_DIR_NAME]);
const CHAIN_TMP_RE = /^\.chain\.json\..*\.tmp$/;
/** Files of a run directory the file table does not list (it is in the first, the second is written after it). */
const RUN_UNLISTED_FILES = new Set([MANIFEST_FILE_NAME, 'manifest.sig']);

/**
 * An incremental run exports the items changed after the previous run's
 * snapshot time minus this overlap: an item committed by a write that began
 * before that snapshot and landed after the previous run read its table is
 * caught; an item exported twice is merged by id on restore.
 */
const INCREMENTAL_OVERLAP_SECONDS = 60;

// A run id names a directory: one safe path segment.
const RUN_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const CHAIN_ID_RE = /^[0-9a-f]{32}$/;
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

// Open for reading without following a symbolic link (where the platform has the flag).
const NO_FOLLOW_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
const PRIVATE_FILE_MODE = 0o600;

type ChainEncryption = null | { mode: 'symmetric' } | { mode: 'hybrid', recipientKeyFingerprint: string };

type ChainRun = {
  runId: string;
  /** `.` for the full run, `incrementals/<runId>` for an incremental run. */
  path: string;
  backupType: 'full' | 'incremental';
  parentRunId: string | null;
  snapshotBefore: number | null;
  backupTimestamp?: number | null;
  coreVersion?: string;
  /** The ids of the users this run exported. */
  users: string[];
  /**
   * `all`: a run of the whole core, so a user it does not list no longer
   * existed when it ran; `users`: a run of the accounts named (`--user`).
   * Absent (a full backup written before chains): unknown, never evidence.
   */
  scope?: RunScope;
  /** The full run predates chains: its manifest carries no chain fields. */
  bootstrapped?: boolean;
};

type RunScope = 'all' | 'users';

/** A user an applied run exported and a later whole-core run no longer listed. */
type DeletedUser = {
  userId: string;
  /** The latest run listing the user. */
  lastRunId: string;
  /** The first whole-core run after it (it did not list the user). */
  deletedBeforeRunId: string;
};

/**
 * The signing key of a chain, set by its first signed run: every later run
 * must be signed with it. Operational consistency only (chain.json is
 * cleartext): trust comes from the public key given at restore.
 */
type ChainSigning = { alg: 'ed25519', keyFingerprint: string };

type Chain = {
  formatVersion: number;
  chainId: string;
  encryption: ChainEncryption;
  signing?: ChainSigning;
  runs: ChainRun[];
};

/** A run's signature file, next to its manifest. */
type ManifestSignature = {
  v: number;
  alg: 'ed25519';
  keyFingerprint: string;
  manifestSha256: string;
  signature: string;
};

type BackupChainErrorCode = 'invalid' | 'exists' | 'damaged' | 'incomplete' | 'mismatch' | 'key-model' | 'secret' | 'deleted' | 'concurrent' | 'integrity' | 'signature';

/** The file table of a run (`integrity` in its manifest): path relative to the run -> size, sha256 of the bytes on disk. */
type FileTable = Map<string, { size: number, sha256: string }>;

type RunIntegrity = {
  version: number;
  /** 2: every file of the run is in cipher format 2; null: a plaintext run. */
  cipher: number | null;
  files: FileTable;
};

class BackupChainError extends Error {
  code: BackupChainErrorCode;
  constructor (code: BackupChainErrorCode, message: string) {
    super(message);
    this.name = 'BackupChainError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Messages shared by backup, restore and inspect
// ---------------------------------------------------------------------------

function damagedRestoreMessage (dir: string): string {
  return `The backup at ${dir} holds only the delta of an incremental run that overwrote its full backup ` +
    `(a version before ${CHAIN_RELEASE}): the earlier data is not in it and cannot be recovered from it. ` +
    'Refusing to restore it; pass --allow-incomplete to restore the delta anyway.';
}

function damagedContinueMessage (dir: string): string {
  return `The backup at ${dir} was damaged by an incremental run of a version before ${CHAIN_RELEASE} ` +
    '(its full backup was overwritten by a delta): it cannot be continued or repaired. ' +
    'Take a new full backup into a new directory.';
}

/** Why a user of a chain is not restored (log, report, refusal of a single-user restore). */
function deletedUserMessage (deleted: DeletedUser): string {
  return `User ${deleted.userId} was deleted before run ${deleted.deletedBeforeRunId} of the chain ` +
    `(last exported by run ${deleted.lastRunId}): not restored; --through-run ${deleted.lastRunId} restores the account as of that run.`;
}

function missingRunMessage (dir: string, runId: string, previousRunId: string | null, what: string): string {
  const way = previousRunId != null ? `restore --through-run ${previousRunId} or recover ${runId}` : `recover ${runId}`;
  return `Run ${runId} of the backup chain at ${dir} is missing ${what}; later runs assume it: ${way}.`;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Read a file without following a symbolic link (refused). */
function readNoFollow (filePath: string): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(filePath, NO_FOLLOW_READ_FLAGS);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Backup file ${filePath} is a symbolic link: refused`);
    }
    throw err;
  }
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read a cleartext file of the backup without following a symbolic link; null when absent. */
function readCleartextFile (filePath: string): string | null {
  try {
    return readNoFollow(filePath).toString('utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read a (possibly encrypted) file of the backup without following a
 * symbolic link. `expect` names the file (path relative to its run, run,
 * chain): an encrypted file carrying another identity is refused.
 */
function readBackupBytes (filePath: string, decryptor: BackupDecryptor | null, expect?: DecryptExpectation): Buffer {
  const raw = readNoFollow(filePath);
  return decryptor ? decryptor.decryptBuffer(raw, expect) : raw;
}

/** The identity the files of a chain run carry (a run bootstrapped from a backup before chains names no chain). */
function runIdentityOf (chain: Chain | null, run: Pick<ChainRun, 'runId' | 'bootstrapped'>): { runId: string, chainId: string | null } {
  return { runId: run.runId, chainId: chain != null && run.bootstrapped !== true ? chain.chainId : null };
}

/**
 * Whether `dir` exists as a directory reached without any symbolic link
 * (false when it does not exist). Throws when it is a link, not a directory,
 * or resolves elsewhere: reading through it could import files from outside
 * the backup. `dir` is built from the backup's real root path.
 */
function isRealDirectory (dir: string): boolean {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!stat.isDirectory() || fs.realpathSync(dir) !== path.resolve(dir)) {
    throw new Error(`Backup directory ${dir} is not a directory of the backup (symbolic link or special file): refused`);
  }
  return true;
}

/** Whether `filePath` exists, without following a symbolic link. */
function existsNoFollow (filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** The cleartext `encryption.json` of a run directory, or null. */
function readEnvelope (runDir: string): Envelope | null {
  const text = readCleartextFile(path.join(runDir, ENVELOPE_FILE_NAME));
  if (text == null) return null;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// The file table of a run (manifest `integrity`)
// ---------------------------------------------------------------------------

function integrityError (runId: string, dir: string, what: string): BackupChainError {
  return new BackupChainError('integrity', `Run ${runId} of the backup at ${dir}: ${what}: refused.`);
}

/**
 * The file table of a run's manifest; null for a run written before runs
 * listed their files. A malformed table is refused.
 */
function runIntegrityOf (manifest: Record<string, unknown> | null, runId: string, dir: string): RunIntegrity | null {
  const integrity = manifest?.integrity as { version?: unknown, cipher?: unknown, files?: unknown } | undefined;
  if (integrity == null) return null;
  const bad = (): BackupChainError => integrityError(runId, dir, 'its manifest carries a malformed file table');
  if (integrity.version !== INTEGRITY_VERSION || (integrity.cipher !== null && integrity.cipher !== 2) || !Array.isArray(integrity.files)) throw bad();
  const files: FileTable = new Map();
  for (const f of integrity.files as Array<{ path?: unknown, size?: unknown, sha256?: unknown }>) {
    if (typeof f?.path !== 'string' || f.path === '' || f.path.split('/').some((s) => s === '' || s === '.' || s === '..') ||
      typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0 ||
      typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || files.has(f.path)) throw bad();
    files.set(f.path, { size: f.size, sha256: f.sha256 });
  }
  return { version: integrity.version, cipher: integrity.cipher as number | null, files };
}

/**
 * The regular files of a run directory, relative to it (`/`-separated),
 * without the manifest and its signature; at the root of a backup, without
 * the chain's own files and the `incrementals/` tree. Anything else than a
 * regular file or a directory (a symbolic link, a special file) is refused.
 */
function listRunFiles (runDir: string, isRoot: boolean, runId: string, dir: string): Map<string, number> {
  const out = new Map<string, number>();
  (function walk (abs: string, rel: string) {
    for (const name of fs.readdirSync(abs).sort()) {
      const childRel = rel === '' ? name : rel + '/' + name;
      if (rel === '' && (RUN_UNLISTED_FILES.has(name) || (isRoot && (ROOT_NON_RUN_FILES.has(name) || CHAIN_TMP_RE.test(name))))) continue;
      const childAbs = path.join(abs, name);
      const stat = fs.lstatSync(childAbs);
      if (stat.isDirectory()) walk(childAbs, childRel);
      else if (stat.isFile()) out.set(childRel, stat.size);
      else throw integrityError(runId, dir, `${childRel} is not a regular file (symbolic link or special file)`);
    }
  })(runDir, '');
  return out;
}

/** Completeness of a run against its file table: no file added, none missing, none resized (sizes only, nothing read). */
function checkRunFiles (runDir: string, isRoot: boolean, runId: string, dir: string, integrity: RunIntegrity): void {
  const present = listRunFiles(runDir, isRoot, runId, dir);
  for (const [rel, size] of present) {
    const listed = integrity.files.get(rel);
    if (listed == null) throw integrityError(runId, dir, `unlisted file ${rel} (not in the run's manifest)`);
    if (listed.size !== size) throw integrityError(runId, dir, `file ${rel}: size differs from the run's manifest (${size}, listed ${listed.size})`);
  }
  for (const rel of integrity.files.keys()) {
    if (!present.has(rel)) throw integrityError(runId, dir, `missing file ${rel} (listed by the run's manifest)`);
  }
}

/** Check bytes read from a run against its file table. */
function checkFileHash (raw: Buffer, rel: string, integrity: RunIntegrity, runId: string, dir: string): void {
  const listed = integrity.files.get(rel);
  if (listed == null) throw integrityError(runId, dir, `unlisted file ${rel} (not in the run's manifest)`);
  if (raw.length !== listed.size || crypto.createHash('sha256').update(raw).digest('hex') !== listed.sha256) {
    throw integrityError(runId, dir, `file ${rel} differs from the run's manifest (hash)`);
  }
}

/** Size and sha256 of a file, read in pieces (an attachment may be large), without following a symbolic link. */
function hashFileNoFollow (filePath: string): { size: number, sha256: string } {
  let fd: number;
  try {
    fd = fs.openSync(filePath, NO_FOLLOW_READ_FLAGS);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`Backup file ${filePath} is a symbolic link: refused`);
    throw err;
  }
  try {
    const hash = crypto.createHash('sha256');
    const buf = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      size += n;
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Check every file of a run's table under `prefix` (e.g. one user's
 * directory) against its size and hash, before any of it is used.
 */
function checkFilesUnder (runDir: string, prefix: string, integrity: RunIntegrity, runId: string, dir: string): void {
  for (const [rel, listed] of integrity.files) {
    if (!rel.startsWith(prefix)) continue;
    const got = hashFileNoFollow(path.join(runDir, ...rel.split('/')));
    if (got.size !== listed.size || got.sha256 !== listed.sha256) throw integrityError(runId, dir, `file ${rel} differs from the run's manifest (hash)`);
  }
}

/** The message of a legacy run (no file table). */
function legacyRunNotice (runId: string): string {
  return `Run ${runId}: written before ${INTEGRITY_RELEASE}, its file list is not verified`;
}

/** A run without file table after one with: refused (a host of an earlier release wrote into the chain, or the run was replaced). */
function legacyAfterVerifiedError (runId: string, previousRunId: string, dir: string): BackupChainError {
  return new BackupChainError('integrity', `Run ${runId} of the backup at ${dir} was written in the format of a release before ${INTEGRITY_RELEASE} ` +
    `after run ${previousRunId}, which was not: refused (a backup host running an earlier release wrote into this chain, or the run was replaced). ` +
    `--through-run ${previousRunId} restores up to the last verified run.`);
}

// ---------------------------------------------------------------------------
// Signed runs (`manifest.sig`)
// ---------------------------------------------------------------------------

const SIGNATURE_FILE_NAME = 'manifest.sig';
const SIGNATURE_VERSION = 2;
const SIGNATURE_LABEL = 'pryv-backup-manifest-v2';

/** The bytes signed for a run: a label, the chain and run ids, the hash of `manifest.json` as written. */
function signedMessage (chainId: string | null, runId: string, manifestSha256: string): Buffer {
  return Buffer.from(SIGNATURE_LABEL + '\n' + (chainId ?? '') + '\n' + runId + '\n' + manifestSha256, 'utf8');
}

/** An Ed25519 key (private or public) from a PEM, a KeyObject or `{ key, passphrase }`; anything else is refused. */
function ed25519Key (key: unknown, kind: 'private' | 'public'): KeyObject {
  let obj: KeyObject;
  if (key instanceof crypto.KeyObject) obj = key;
  else if (kind === 'private') obj = crypto.createPrivateKey(key as PrivateKeyInput | string | Buffer);
  else obj = crypto.createPublicKey(key as PublicKeyInput | string | Buffer);
  if (obj.asymmetricKeyType !== 'ed25519') throw new Error(`Backup signing: the ${kind} key is not an Ed25519 key (${String(obj.asymmetricKeyType)})`);
  if (kind === 'public' && obj.type === 'private') obj = crypto.createPublicKey(obj);
  if (obj.type !== (kind === 'private' ? 'private' : 'public')) throw new Error(`Backup signing: a ${kind} key is required`);
  return obj;
}

/** `sha256:<hex>` of the SPKI DER of the public half of a signing key. */
function signingKeyFingerprint (key: KeyObject): string {
  const publicKey = key.type === 'private' ? crypto.createPublicKey(key) : key;
  return 'sha256:' + crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

/** The signature file of a run whose `manifest.json` bytes are `manifestBytes`. */
function signManifest (manifestBytes: Buffer, chainId: string | null, runId: string, privateKey: KeyObject): ManifestSignature {
  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  return {
    v: SIGNATURE_VERSION,
    alg: 'ed25519',
    keyFingerprint: signingKeyFingerprint(privateKey),
    manifestSha256,
    signature: crypto.sign(null, signedMessage(chainId, runId, manifestSha256), privateKey).toString('base64')
  };
}

/** The signature file of a run directory, parsed (null when there is none or it is not JSON). */
function readManifestSignature (runDir: string): ManifestSignature | null {
  const text = readCleartextFile(path.join(runDir, SIGNATURE_FILE_NAME));
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

/**
 * Verify a run's signature against the public key given at restore: present,
 * of that key, over these manifest bytes, this run and chain. Returns nothing;
 * throws a `signature` error naming the run.
 */
function verifyManifestSignature (runDir: string, manifestBytes: Buffer, chainId: string | null, runId: string, publicKey: KeyObject, dir: string): void {
  const refuse = (why: string): BackupChainError => new BackupChainError('signature', `Run ${runId} of the backup at ${dir}: not signed by the key given (--signing-pubkey): ${why}: refused.`);
  const sig = readManifestSignature(runDir);
  if (sig == null) throw refuse('no manifest.sig');
  if (sig.v !== SIGNATURE_VERSION || sig.alg !== 'ed25519' || typeof sig.signature !== 'string') throw refuse('unknown signature format');
  if (sig.keyFingerprint !== signingKeyFingerprint(publicKey)) throw refuse(`signed with another key (${String(sig.keyFingerprint)})`);
  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  if (sig.manifestSha256 !== manifestSha256) throw refuse('manifest.json differs from the signed one');
  let ok = false;
  try {
    ok = crypto.verify(null, signedMessage(chainId, runId, manifestSha256), publicKey, Buffer.from(sig.signature, 'base64'));
  } catch (err) {
    ok = false;
  }
  if (!ok) throw refuse('the signature does not verify');
}

/** The `signed:` part of an inspect line. */
function describeSignature (runDir: string): string {
  const sig = readManifestSignature(runDir);
  if (sig == null) return 'signed: no';
  return `signed: yes, key ${String(sig.keyFingerprint)}`;
}

/** The file format version the run pins (`2` refuses a file of the first format), or undefined. */
function requiredFormatOf (integrity: RunIntegrity | null): number | undefined {
  return integrity?.cipher === 2 ? 2 : undefined;
}

// ---------------------------------------------------------------------------
// chain.json
// ---------------------------------------------------------------------------

function invalidChain (dir: string, why: string): BackupChainError {
  return new BackupChainError('invalid', `The chain.json of the backup at ${dir} is not valid (${why}): refused.`);
}

function validateEncryption (encryption: unknown, dir: string): void {
  if (encryption === null) return;
  const enc = encryption as { mode?: unknown, recipientKeyFingerprint?: unknown } | undefined;
  if (enc?.mode === 'symmetric') return;
  if (enc?.mode === 'hybrid' && typeof enc.recipientKeyFingerprint === 'string' && FINGERPRINT_RE.test(enc.recipientKeyFingerprint)) return;
  throw invalidChain(dir, 'unknown encryption');
}

/** Check the shape of a parsed `chain.json`: the runs it names become paths. */
function validateChain (chain: unknown, dir: string): asserts chain is Chain {
  const c = chain as Partial<Chain> | null;
  if (c == null || typeof c !== 'object') throw invalidChain(dir, 'not an object');
  if (c.formatVersion !== CHAIN_FORMAT_VERSION) throw invalidChain(dir, 'unknown formatVersion ' + JSON.stringify(c.formatVersion));
  if (typeof c.chainId !== 'string' || !CHAIN_ID_RE.test(c.chainId)) throw invalidChain(dir, 'chainId');
  validateEncryption(c.encryption, dir);
  if (c.signing !== undefined && (c.signing == null || c.signing.alg !== 'ed25519' || typeof c.signing.keyFingerprint !== 'string' || !FINGERPRINT_RE.test(c.signing.keyFingerprint))) {
    throw invalidChain(dir, 'signing');
  }
  if (!Array.isArray(c.runs) || c.runs.length === 0) throw invalidChain(dir, 'no runs');
  const seen = new Set<string>();
  c.runs.forEach((run: ChainRun, i: number) => {
    if (run == null || typeof run !== 'object') throw invalidChain(dir, `run ${i}`);
    if (i === 0) {
      if (run.runId !== FULL_RUN_ID || run.path !== '.' || run.backupType !== 'full' || run.parentRunId != null) {
        throw invalidChain(dir, 'the first run must be the full run at the root');
      }
    } else {
      if (typeof run.runId !== 'string' || !RUN_ID_RE.test(run.runId) || run.runId === FULL_RUN_ID) {
        throw invalidChain(dir, `run id ${JSON.stringify(run.runId)}`);
      }
      if (run.path !== INCREMENTALS_DIR_NAME + '/' + run.runId || run.backupType !== 'incremental') {
        throw invalidChain(dir, `run ${run.runId}: path or type`);
      }
      if (run.parentRunId !== c.runs![i - 1].runId) throw invalidChain(dir, `run ${run.runId}: parent`);
    }
    if (seen.has(run.runId)) throw invalidChain(dir, `run ${run.runId} listed twice`);
    seen.add(run.runId);
    if (!Array.isArray(run.users) || !run.users.every((u) => typeof u === 'string')) throw invalidChain(dir, `run ${run.runId}: users`);
    if (run.snapshotBefore != null && typeof run.snapshotBefore !== 'number') throw invalidChain(dir, `run ${run.runId}: snapshotBefore`);
    if (run.scope != null && run.scope !== 'all' && run.scope !== 'users') throw invalidChain(dir, `run ${run.runId}: scope`);
  });
}

/** Read and check the `chain.json` of a backup directory; null when there is none. */
function readChain (dir: string): Chain | null {
  const text = readCleartextFile(path.join(dir, CHAIN_FILE_NAME));
  if (text == null) return null;
  let chain: unknown;
  try {
    chain = JSON.parse(text);
  } catch (err) {
    throw invalidChain(dir, 'not JSON');
  }
  validateChain(chain, dir);
  return chain;
}

/** Write `chain.json`: a temporary file renamed over the previous one. */
function writeChainAtomic (dir: string, chain: Chain): void {
  validateChain(chain, dir);
  const tmp = path.join(dir, `.${CHAIN_FILE_NAME}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(chain, null, 2), { mode: PRIVATE_FILE_MODE, flag: 'wx' });
  fs.chmodSync(tmp, PRIVATE_FILE_MODE);
  fs.renameSync(tmp, path.join(dir, CHAIN_FILE_NAME));
}

const CHAIN_LOCK_FILE_NAME = '.chain.lock';
/** A lock older than this belongs to a dead run (the section it guards takes milliseconds). */
const CHAIN_LOCK_STALE_MS = 60_000;

/**
 * Run `fn` holding the chain lock of `dir`: a file created with exclusive
 * create (`wx`), removed afterwards. Another run's lock, younger than
 * CHAIN_LOCK_STALE_MS, refuses this run (`concurrent`); an older one is a
 * leftover of a crashed run and is taken over.
 */
function withChainLock<T> (dir: string, runId: string, runPath: string, fn: () => T): T {
  const lockPath = path.join(dir, CHAIN_LOCK_FILE_NAME);
  const take = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx', PRIVATE_FILE_MODE);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, runId, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };
  if (!take()) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Released meanwhile (stat null), or stale: one more try.
    if (stat != null && Date.now() - stat.mtimeMs > CHAIN_LOCK_STALE_MS) {
      try { fs.unlinkSync(lockPath); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
    if ((stat != null && Date.now() - stat.mtimeMs <= CHAIN_LOCK_STALE_MS) || !take()) {
      let holder = '';
      try {
        const held = JSON.parse(readNoFollow(lockPath).toString('utf8'));
        holder = ` (run ${String(held.runId)}, since ${new Date(held.at).toISOString()})`;
      } catch (err) { /* unreadable: named without its holder */ }
      throw new BackupChainError('concurrent', `Another backup run holds ${lockPath}${holder}: run ${runId} is left as a stray ${runPath}/ that restore ignores. ` +
        'Run the backup again; if no run is in progress, remove the lock file.');
    }
  }
  try {
    return fn();
  } finally {
    releaseChainLock(lockPath);
  }
}

function releaseChainLock (lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** `<yyyymmddThhmmssZ>-<8 hex>`: sortable for a human; chain order is what counts. */
function newRunId (now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return stamp + '-' + crypto.randomBytes(4).toString('hex');
}

function newChainId (): string {
  return crypto.randomBytes(16).toString('hex');
}

/** The chain's key model for an encryptor (null: plaintext). */
function chainEncryptionOf (encryptor: { envelope: Envelope, recipientKeyFingerprint?: string } | null | undefined): ChainEncryption {
  if (encryptor == null) return null;
  if (encryptor.envelope.mode === 'hybrid') {
    if (encryptor.recipientKeyFingerprint == null) throw new Error('A hybrid backup encryptor must carry its recipient key fingerprint');
    return { mode: 'hybrid', recipientKeyFingerprint: encryptor.recipientKeyFingerprint };
  }
  return { mode: 'symmetric' };
}

function describeEncryption (encryption: ChainEncryption): string {
  if (encryption == null) return 'none (plaintext)';
  if (encryption.mode === 'hybrid') return `hybrid (recipient key ${encryption.recipientKeyFingerprint})`;
  return 'symmetric (passphrase)';
}

/**
 * The chain of a full backup written before chains existed: one run at the
 * root. Refused when the manifest is the one an earlier incremental run wrote
 * over the full backup (the directory holds only that delta).
 */
function bootstrapChainFromManifest (manifest: { backupType?: unknown, snapshotBefore?: unknown, backupTimestamp?: unknown, coreVersion?: unknown, users?: unknown }, encryption: ChainEncryption, dir: string): Chain {
  if (manifest.backupType === 'incremental') throw new BackupChainError('damaged', damagedContinueMessage(dir));
  if (manifest.backupType !== 'full' || typeof manifest.snapshotBefore !== 'number') {
    throw new BackupChainError('invalid', `The backup at ${dir} has no snapshot time in its manifest: it cannot be continued. Take a new full backup into a new directory.`);
  }
  const users = Array.isArray(manifest.users) ? manifest.users.map((u: { userId?: unknown }) => u?.userId).filter((id): id is string => typeof id === 'string') : [];
  return {
    formatVersion: CHAIN_FORMAT_VERSION,
    chainId: newChainId(),
    encryption,
    runs: [{
      runId: FULL_RUN_ID,
      path: '.',
      backupType: 'full',
      parentRunId: null,
      snapshotBefore: manifest.snapshotBefore,
      backupTimestamp: typeof manifest.backupTimestamp === 'number' ? manifest.backupTimestamp : null,
      coreVersion: typeof manifest.coreVersion === 'string' ? manifest.coreVersion : undefined,
      users,
      bootstrapped: true
    }]
  };
}

/**
 * `since` per user for the next incremental run: the snapshot time of the
 * latest run that exported the user, minus the overlap. A user no run lists
 * is absent (fully exported).
 */
function sinceByUser (chain: Chain): Record<string, number> {
  const map: Record<string, number> = {};
  for (const run of chain.runs) {
    if (typeof run.snapshotBefore !== 'number') continue;
    for (const userId of run.users) map[userId] = run.snapshotBefore - INCREMENTAL_OVERLAP_SECONDS;
  }
  return map;
}

/**
 * The users deleted along the runs given (the applied runs of a restore, in
 * chain order): a user is deleted when a whole-core run (`scope: 'all'`)
 * newer than the latest run listing the user does not list them. A run of
 * the accounts named, or a run without scope, is evidence of nothing. Over a
 * prefix of the chain (`--through-run`), a user deleted later is present.
 */
function deletedUsersOf (runs: Array<Pick<ChainRun, 'runId' | 'users' | 'scope'>>): DeletedUser[] {
  // Insertion order of a Map: the order in which the runs first list the users.
  const lastIndex = new Map<string, number>();
  runs.forEach((run, i) => { for (const userId of run.users) lastIndex.set(userId, i); });
  const deleted: DeletedUser[] = [];
  for (const [userId, last] of lastIndex) {
    const later = runs.findIndex((run, i) => i > last && run.scope === 'all');
    if (later >= 0) deleted.push({ userId, lastRunId: runs[last].runId, deletedBeforeRunId: runs[later].runId });
  }
  return deleted;
}

/** Directories under `incrementals/` that the chain does not list (crashed runs, foreign files): ignored. */
function listStrays (dir: string, chain: Chain | null): string[] {
  const incDir = path.join(dir, INCREMENTALS_DIR_NAME);
  if (!existsNoFollow(incDir)) return [];
  const listed = new Set((chain?.runs ?? []).map((r) => r.path));
  let names: string[];
  try {
    names = fs.readdirSync(incDir);
  } catch (err) {
    return [INCREMENTALS_DIR_NAME];
  }
  return names
    .map((name) => INCREMENTALS_DIR_NAME + '/' + name)
    .filter((p) => !listed.has(p))
    .sort();
}

/**
 * The runs a restore applies, in order: the chain's runs up to `throughRun`
 * when given, or the one run at the root of a backup without `chain.json`.
 */
function resolveRuns (dir: string, options: { throughRun?: string | null } = {}): { chain: Chain | null, runs: ChainRun[], strays: string[] } {
  const chain = readChain(dir);
  const strays = listStrays(dir, chain);
  if (chain == null) {
    if (options.throughRun != null && options.throughRun !== FULL_RUN_ID) {
      throw new BackupChainError('invalid', `--through-run ${options.throughRun}: the backup at ${dir} has no chain.json (one run: ${FULL_RUN_ID}).`);
    }
    return { chain, runs: [{ runId: FULL_RUN_ID, path: '.', backupType: 'full', parentRunId: null, snapshotBefore: null, users: [] }], strays };
  }
  let runs = chain.runs;
  if (options.throughRun != null) {
    const index = runs.findIndex((r) => r.runId === options.throughRun);
    if (index < 0) {
      throw new BackupChainError('invalid', `--through-run ${options.throughRun}: no such run in the backup chain at ${dir} (runs: ${runs.map((r) => r.runId).join(', ')}).`);
    }
    runs = runs.slice(0, index + 1);
  }
  return { chain, runs, strays };
}

/** The directory of a run, below the backup's real root; every directory on the way is checked. */
function runDirectory (root: string, run: ChainRun): string {
  if (run.path === '.') return root;
  const incDir = path.join(root, INCREMENTALS_DIR_NAME);
  const runDir = path.join(incDir, run.runId);
  if (!isRealDirectory(incDir) || !isRealDirectory(runDir)) return '';
  return runDir;
}

/**
 * The manifest of a run of a chain: present, readable with the run's
 * decryptor, and naming this chain, this run and its parent run (a run
 * directory grafted from another chain, or a swapped or reordered
 * `chain.json`, is refused). A consistency check, not an authentication.
 */
function readRunManifest (root: string, dir: string, chain: Chain, run: ChainRun, previousRunId: string | null, decryptor: BackupDecryptor | null, signingPubKey?: KeyObject | null): Record<string, unknown> {
  const runDir = runDirectory(root, run);
  const manifestPath = runDir === '' ? '' : path.join(runDir, MANIFEST_FILE_NAME);
  if (runDir === '' || !existsNoFollow(manifestPath)) {
    throw new BackupChainError('incomplete', missingRunMessage(dir, run.runId, previousRunId, 'its manifest'));
  }
  const identity = runIdentityOf(chain, run);
  // Read once: the signature (when a public key is given) covers these bytes,
  // checked before anything is decrypted or parsed.
  const raw = readNoFollow(manifestPath);
  if (signingPubKey != null) verifyManifestSignature(runDir, raw, identity.chainId, run.runId, signingPubKey, dir);
  const manifest = JSON.parse((decryptor ? decryptor.decryptBuffer(raw, { path: MANIFEST_FILE_NAME, ...identity }) : raw).toString('utf8'));
  const pre = run.bootstrapped === true && manifest.chainId == null && manifest.runId == null;
  if (!pre && (manifest.chainId !== chain.chainId || manifest.runId !== run.runId || (manifest.parentRunId ?? null) !== (run.parentRunId ?? null))) {
    throw new BackupChainError('mismatch', `Run ${run.runId} of the backup chain at ${dir} does not belong to this chain (its manifest names another chain, run or parent run): refused.`);
  }
  checkChainEntry(dir, run, manifest);
  return manifest;
}

/**
 * The entry of a run in `chain.json` (cleartext) must say what the run's
 * manifest says (authenticated in an encrypted run): its users, its scope,
 * its snapshot time. An edited entry could otherwise withhold an account
 * from the restore, or have one taken for deleted.
 */
function checkChainEntry (dir: string, run: ChainRun, manifest: Record<string, unknown>): void {
  const mismatch = (field: string): BackupChainError => new BackupChainError('mismatch',
    `Run ${run.runId} of the backup chain at ${dir}: chain.json disagrees with the run's manifest (${field}): chain.json was edited; refused.`);
  const manifestUsers = Array.isArray(manifest.users) ? (manifest.users as Array<{ userId?: unknown }>).map((u) => u?.userId).filter((id): id is string => typeof id === 'string') : [];
  const a = [...new Set(manifestUsers)].sort();
  const b = [...new Set(run.users)].sort();
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) throw mismatch('users');
  if (((manifest.snapshotBefore as number | null | undefined) || null) !== (run.snapshotBefore || null)) throw mismatch('snapshotBefore');
  const manifestScope = (manifest.scope as RunScope | undefined) ?? null;
  const entryScope = run.scope ?? null;
  // A run bootstrapped from a backup before chains has no scope in its entry: unknown, never evidence.
  if (entryScope !== manifestScope && !(run.bootstrapped === true && entryScope == null)) throw mismatch('scope');
}

/**
 * The key model of a run must be the chain's: an envelope in a plaintext
 * chain, no envelope in an encrypted one, or another mode is refused (a
 * plaintext file could otherwise stand in for an encrypted one).
 */
function checkRunEnvelope (dir: string, chain: Chain, run: ChainRun, envelope: Envelope | null): void {
  if (chain.encryption == null && envelope != null) {
    throw new BackupChainError('key-model', `Run ${run.runId} of the backup chain at ${dir} has an encryption.json but the chain is plaintext: refused.`);
  }
  if (chain.encryption != null && envelope == null) {
    throw new BackupChainError('key-model', `Run ${run.runId} of the backup chain at ${dir} has no encryption.json but the chain is encrypted: refused.`);
  }
  if (chain.encryption != null && envelope != null && envelope.mode !== chain.encryption.mode) {
    throw new BackupChainError('key-model', `Run ${run.runId} of the backup chain at ${dir} is encrypted ${String(envelope.mode)}, the chain ${chain.encryption.mode}: refused.`);
  }
}

// ---------------------------------------------------------------------------
// Planning a backup run (`bin/backup.js --output`)
// ---------------------------------------------------------------------------

interface PlanOptions {
  incremental?: boolean;
  /** Symmetric model: the passphrase of this run. */
  passphrase?: string | null;
  /** Hybrid model: the recipient public key of this run. */
  recipientPubKeyPem?: string | Buffer | null;
  /** Only to read the manifest of a hybrid full backup written before chains (once). */
  privateKeyPem?: string | Buffer | null;
  privateKeyPassphrase?: string | null;
  /** `sha256:<hex>` of the signing key of this run (null: unsigned); a signed chain needs its own key. */
  signingKeyFingerprint?: string | null;
}

interface RunPlan {
  runId: string;
  path: string;
  parentRunId: string | null;
  chainId: string;
  /** The chain this run is appended to (null for the full run). */
  baseChain: Chain | null;
  isIncremental: boolean;
  encryption: ChainEncryption;
  strays: string[];
}

function modelName (encryption: ChainEncryption): string {
  return encryption == null ? 'plaintext' : encryption.mode;
}

/** Refuse a run whose key model is not the chain's. */
function checkKeyModel (dir: string, existing: ChainEncryption, requested: ChainEncryption): void {
  const sameModel = 'continue it with the same key model, or start a new chain in a new directory.';
  if (existing == null && requested != null) {
    throw new BackupChainError('key-model', `The backup chain at ${dir} is plaintext and this run would encrypt (${requested.mode}): ${sameModel}`);
  }
  if (existing != null && requested == null) {
    const flag = existing.mode === 'hybrid' ? '--recipient-pubkey' : '--passphrase-file';
    throw new BackupChainError('key-model', `The backup chain at ${dir} is encrypted (${existing.mode}) and this run would write plaintext: ${sameModel} (${flag})`);
  }
  if (existing != null && requested != null && existing.mode !== requested.mode) {
    throw new BackupChainError('key-model', `The backup chain at ${dir} is encrypted ${modelName(existing)} and this run asks for ${modelName(requested)}: ${sameModel}`);
  }
  if (existing?.mode === 'hybrid' && requested?.mode === 'hybrid' && existing.recipientKeyFingerprint !== requested.recipientKeyFingerprint) {
    throw new BackupChainError('key-model', `The recipient key differs from the one of the backup chain at ${dir}: refused (nothing written). Continue the chain with the same --recipient-pubkey, or start a new chain in a new directory.`);
  }
}

/** A chain signed with a key is continued with that key only (checked before anything is written). */
function checkSigningKey (dir: string, chain: Chain, fingerprint: string | null): void {
  const pinned = chain.signing?.keyFingerprint ?? null;
  if (pinned == null) return;
  if (fingerprint == null) {
    throw new BackupChainError('key-model', `The backup chain at ${dir} is signed with key ${pinned}: pass the same --signing-key (nothing written).`);
  }
  if (fingerprint !== pinned) {
    throw new BackupChainError('key-model', `The signing key (${fingerprint}) differs from the one of the backup chain at ${dir} (${pinned}): refused (nothing written). Continue the chain with the same --signing-key, or start a new chain in a new directory.`);
  }
}

function decryptorOrSecretError (dir: string, envelope: Envelope, secrets: DecryptorSecrets): BackupDecryptor {
  try {
    return createBackupDecryptor(envelope, secrets);
  } catch (err) {
    throw new BackupChainError('secret', `Cannot read the existing backup at ${dir}: ${(err as Error).message}.`);
  }
}

/**
 * Decide what a backup run into `dir` writes, and refuse before anything is
 * written when it cannot: a backup already there without `--incremental`, a
 * damaged directory, another key model, a passphrase that does not decrypt
 * the chain, another recipient key.
 */
function planBackupRun (dir: string, options: PlanOptions = {}): RunPlan {
  const requested: ChainEncryption = options.recipientPubKeyPem
    ? { mode: 'hybrid', recipientKeyFingerprint: recipientKeyFingerprint(options.recipientPubKeyPem) }
    : options.passphrase ? { mode: 'symmetric' } : null;

  let chain = existsNoFollow(dir) ? readChain(dir) : null;
  const hasManifest = existsNoFollow(path.join(dir, MANIFEST_FILE_NAME));
  if (chain == null && !hasManifest) {
    return { runId: FULL_RUN_ID, path: '.', parentRunId: null, chainId: newChainId(), baseChain: null, isIncremental: false, encryption: requested, strays: [] };
  }
  if (!options.incremental) {
    throw new BackupChainError('exists', `Backup already exists at ${dir} (manifest.json found). ` +
      'Use --incremental for incremental backup, or choose a different output path.');
  }

  if (chain == null) {
    // A full backup written before chains: its manifest starts the chain.
    const envelope = readEnvelope(dir);
    if (envelope == null) {
      checkKeyModel(dir, null, requested);
    } else if (requested == null || requested.mode !== envelope.mode) {
      // The envelope does not name the recipient key: the mode is what can be compared here.
      checkKeyModel(dir, envelope.mode === 'hybrid' ? { mode: 'hybrid', recipientKeyFingerprint: 'unknown' } : { mode: 'symmetric' }, requested);
    }
    let decryptor: BackupDecryptor | null = null;
    if (envelope != null) {
      if (envelope.mode === 'hybrid') {
        if (!options.privateKeyPem) {
          throw new BackupChainError('secret', `The backup at ${dir} was written before ${CHAIN_RELEASE} and is encrypted with a recipient key: ` +
            'pass the matching --private-key once, to read its manifest and start the chain (later runs need the public key only).');
        }
        const own = recipientKeyFingerprint({ key: options.privateKeyPem, passphrase: options.privateKeyPassphrase ?? undefined });
        if (requested?.mode === 'hybrid' && own !== requested.recipientKeyFingerprint) {
          throw new BackupChainError('key-model', `The recipient key differs from the one of the backup at ${dir} (--private-key and --recipient-pubkey are not a pair): refused (nothing written).`);
        }
      }
      decryptor = decryptorOrSecretError(dir, envelope, {
        passphrase: options.passphrase ?? undefined,
        privateKeyPem: options.privateKeyPem ?? undefined,
        privateKeyPassphrase: options.privateKeyPassphrase ?? undefined
      });
    }
    let manifest;
    try {
      manifest = JSON.parse(readBackupBytes(path.join(dir, MANIFEST_FILE_NAME), decryptor, { path: MANIFEST_FILE_NAME, runId: FULL_RUN_ID, chainId: null }).toString('utf8'));
    } catch (err) {
      if (envelope?.mode === 'symmetric') throw new BackupChainError('secret', `The passphrase does not decrypt the existing backup at ${dir}: refused (nothing written).`);
      throw new BackupChainError('secret', `Cannot read the manifest of the existing backup at ${dir}: ${(err as Error).message}.`);
    }
    chain = bootstrapChainFromManifest(manifest, requested, dir);
  } else {
    checkKeyModel(dir, chain.encryption, requested);
    if (chain.encryption?.mode === 'symmetric') {
      // The passphrase must decrypt the latest run: any file's GCM tag tells.
      const latest = chain.runs[chain.runs.length - 1];
      const previous = chain.runs.length > 1 ? chain.runs[chain.runs.length - 2].runId : null;
      const root = fs.realpathSync(dir);
      const runDir = runDirectory(root, latest);
      const envelope = runDir === '' ? null : readEnvelope(runDir);
      if (runDir === '' || envelope == null || !existsNoFollow(path.join(runDir, MANIFEST_FILE_NAME))) {
        throw new BackupChainError('incomplete', missingRunMessage(dir, latest.runId, previous, 'its manifest or its encryption.json') +
          ' It cannot be continued: take a new full backup into a new directory.');
      }
      try {
        const decryptor = createBackupDecryptor(envelope, { passphrase: options.passphrase ?? undefined });
        readBackupBytes(path.join(runDir, MANIFEST_FILE_NAME), decryptor, { path: MANIFEST_FILE_NAME, ...runIdentityOf(chain, latest) });
      } catch (err) {
        throw new BackupChainError('secret', `The passphrase does not decrypt the existing backup chain at ${dir}: refused (nothing written).`);
      }
    }
  }

  checkSigningKey(dir, chain, options.signingKeyFingerprint ?? null);

  const last = chain.runs[chain.runs.length - 1];
  const runId = newRunId();
  return {
    runId,
    path: INCREMENTALS_DIR_NAME + '/' + runId,
    parentRunId: last.runId,
    chainId: chain.chainId,
    baseChain: chain,
    isIncremental: true,
    encryption: chain.encryption,
    strays: listStrays(dir, chain)
  };
}

// ---------------------------------------------------------------------------
// Inspecting a backup directory (`bin/backup.js --inspect`)
// ---------------------------------------------------------------------------

type InspectStatus = 'ok' | 'damaged' | 'incomplete' | 'unknown' | 'invalid' | 'failed';

interface InspectReport {
  lines: string[];
  verdict: string;
  status: InspectStatus;
}

function isoOf (snapshotBefore: number | null | undefined): string {
  return typeof snapshotBefore === 'number' ? new Date(snapshotBefore * 1000).toISOString() : 'unknown';
}

/**
 * Describe a backup directory and say whether it is sound. A chain needs no
 * secret (`chain.json` is cleartext); a backup written before chains needs
 * the secret of its encryption to read the root manifest.
 */
function inspectBackup (dir: string, options: { secrets?: DecryptorSecrets, verifyFiles?: boolean, signingPubKey?: KeyObject | null } = {}): InspectReport {
  const lines: string[] = [`Backup directory: ${dir}`];
  const report = (status: InspectStatus, verdict: string): InspectReport => ({ lines, verdict, status });
  if (!existsNoFollow(dir)) return report('invalid', 'INVALID: no such directory');
  let root: string;
  let chain: Chain | null;
  try {
    root = fs.realpathSync(dir);
    chain = readChain(root);
  } catch (err) {
    return report('invalid', 'INVALID: ' + (err as Error).message);
  }

  if (chain != null) {
    lines.push(`Chain: ${chain.chainId}`);
    lines.push(`Encryption: ${describeEncryption(chain.encryption)}`);
    if (chain.signing != null) lines.push(`Signing key: ${chain.signing.keyFingerprint}`);
    lines.push(`Runs: ${chain.runs.length}`);
    for (const run of chain.runs) {
      lines.push(`  ${run.runId}  ${run.backupType}  scope ${run.scope ?? 'unknown'}  snapshot ${isoOf(run.snapshotBefore)}  ${run.users.length} user(s)`);
    }
    for (const d of deletedUsersOf(chain.runs)) {
      lines.push(`  deleted before run ${d.deletedBeforeRunId}: ${d.userId} (last in run ${d.lastRunId})`);
    }
    const strays = listStrays(root, chain);
    for (const stray of strays) lines.push(`  stray (not in the chain, ignored): ${stray}`);
    for (let i = 0; i < chain.runs.length; i++) {
      const run = chain.runs[i];
      let runDir;
      try {
        runDir = runDirectory(root, run);
      } catch (err) {
        return report('invalid', 'INVALID: ' + (err as Error).message);
      }
      if (runDir === '' || !existsNoFollow(path.join(runDir, MANIFEST_FILE_NAME))) {
        return report('incomplete', `INCOMPLETE: run ${run.runId} has no manifest`);
      }
      if (chain.encryption != null && !existsNoFollow(path.join(runDir, ENVELOPE_FILE_NAME))) {
        return report('incomplete', `INCOMPLETE: run ${run.runId} has no encryption.json`);
      }
    }
    // The file table of each run: readable with the secret of an encrypted
    // chain (or in the clear); checked file by file with verifyFiles.
    const secrets = options.secrets ?? {};
    const hasSecret = !!(secrets.passphrase || secrets.privateKeyPem);
    let unreadable = false;
    let lastVerified: string | null = null;
    const pubKey = options.signingPubKey ?? null;
    for (let i = 0; i < chain.runs.length; i++) {
      const run = chain.runs[i];
      const runDir = runDirectory(root, run);
      const signed = inspectRunSignature(runDir, runIdentityOf(chain, run).chainId, run.runId, pubKey, dir);
      if (signed.failure != null) return report('failed', 'FAILED: ' + signed.failure);
      lines.push(`  ${run.runId}: ${signed.line}`);
      if (chain.encryption != null && !hasSecret) {
        lines.push(`  ${run.runId}: files: not readable without the secret`);
        unreadable = true;
        continue;
      }
      let manifest: Record<string, unknown>;
      try {
        const envelope = readEnvelope(runDir);
        const decryptor = envelope == null ? null : createBackupDecryptor(envelope, secrets, runIdentityOf(chain, run));
        manifest = readRunManifest(root, dir, chain, run, i > 0 ? chain.runs[i - 1].runId : null, decryptor);
      } catch (err) {
        if (err instanceof BackupChainError) return report(err.code === 'mismatch' ? 'failed' : 'invalid', (err.code === 'mismatch' ? 'FAILED: ' : 'INVALID: ') + err.message);
        lines.push(`  ${run.runId}: files: not readable (${(err as Error).message})`);
        unreadable = true;
        continue;
      }
      const result = inspectRunFiles(dir, run.runId, runDir, run.path === '.', manifest, options.verifyFiles === true);
      if (result.failure != null) return report('failed', 'FAILED: ' + result.failure);
      if (result.legacy && lastVerified != null) return report('failed', 'FAILED: ' + legacyAfterVerifiedError(run.runId, lastVerified, dir).message);
      if (!result.legacy) lastVerified = run.runId;
      lines.push(`  ${run.runId}: ${result.line}`);
    }
    if (options.verifyFiles === true && unreadable) return report('unknown', 'UNKNOWN: the files cannot be verified without the secret: pass --passphrase-file / --private-key');
    return report('ok', `OK (${chain.runs.length} run${chain.runs.length === 1 ? '' : 's'})`);
  }

  const manifestPath = path.join(root, MANIFEST_FILE_NAME);
  if (!existsNoFollow(manifestPath)) return report('invalid', 'INVALID: no manifest.json and no chain.json (not a backup directory)');
  for (const stray of listStrays(root, null)) lines.push(`  stray (no chain.json lists it, ignored): ${stray}`);
  let envelope: Envelope | null;
  try {
    envelope = readEnvelope(root);
  } catch (err) {
    return report('invalid', 'INVALID: ' + (err as Error).message);
  }
  lines.push(`Encryption: ${envelope == null ? 'none (plaintext)' : String(envelope.mode)}`);
  const secrets = options.secrets ?? {};
  if (envelope != null && !secrets.passphrase && !secrets.privateKeyPem) {
    return report('unknown', 'UNKNOWN: pass --passphrase-file / --private-key to read the manifest');
  }
  let manifest;
  try {
    const decryptor = envelope == null ? null : createBackupDecryptor(envelope, secrets);
    manifest = JSON.parse(readBackupBytes(manifestPath, decryptor, { path: MANIFEST_FILE_NAME, runId: FULL_RUN_ID, chainId: null }).toString('utf8'));
  } catch (err) {
    return report('unknown', 'UNKNOWN: the manifest cannot be read (' + (err as Error).message + ')');
  }
  lines.push(`Manifest: ${String(manifest.backupType)}, snapshot ${isoOf(manifest.snapshotBefore)}, ${Array.isArray(manifest.users) ? manifest.users.length : 0} user(s)`);
  if (manifest.backupType === 'incremental') {
    lines.push(damagedRestoreMessage(dir));
    return report('damaged', 'DAMAGED: the root manifest says "incremental" and there is no chain.json');
  }
  const signed = inspectRunSignature(root, null, FULL_RUN_ID, options.signingPubKey ?? null, dir);
  if (signed.failure != null) return report('failed', 'FAILED: ' + signed.failure);
  lines.push(`  ${FULL_RUN_ID}: ${signed.line}`);
  const result = inspectRunFiles(dir, FULL_RUN_ID, root, true, manifest, options.verifyFiles === true);
  if (result.failure != null) return report('failed', 'FAILED: ' + result.failure);
  lines.push(`  ${FULL_RUN_ID}: ${result.line}`);
  return report('ok', result.legacy ? `OK (full backup written before ${CHAIN_RELEASE}, one run)` : 'OK (full backup without chain, one run)');
}

/** The `signed:` line of a run for `--inspect`; with a public key, the signature verified. */
function inspectRunSignature (runDir: string, chainId: string | null, runId: string, pubKey: KeyObject | null, dir: string): { line: string, failure?: string } {
  const line = describeSignature(runDir);
  if (pubKey == null) return { line: line === 'signed: no' ? line : line + ' (not verified: pass --signing-pubkey)' };
  try {
    verifyManifestSignature(runDir, readNoFollow(path.join(runDir, MANIFEST_FILE_NAME)), chainId, runId, pubKey, dir);
  } catch (err) {
    return { line, failure: (err as Error).message };
  }
  return { line: line + ', verified' };
}

/**
 * The `files:` line of a run for `--inspect`: how many files its manifest
 * lists, or that it lists none (an earlier release); with `verify`, every
 * listed file present with its size and hash, nothing added.
 */
function inspectRunFiles (dir: string, runId: string, runDir: string, isRoot: boolean, manifest: Record<string, unknown>, verify: boolean): { line: string, legacy: boolean, failure?: string } {
  let integrity: RunIntegrity | null;
  try {
    integrity = runIntegrityOf(manifest, runId, dir);
  } catch (err) {
    return { line: '', legacy: false, failure: (err as Error).message };
  }
  if (integrity == null) return { line: `files: not verified (written before ${INTEGRITY_RELEASE})`, legacy: true };
  if (!verify) return { line: `files: ${integrity.files.size} listed`, legacy: false };
  try {
    checkRunFiles(runDir, isRoot, runId, dir, integrity);
    checkFilesUnder(runDir, '', integrity, runId, dir);
  } catch (err) {
    return { line: '', legacy: false, failure: (err as Error).message };
  }
  return { line: `files: ${integrity.files.size} verified`, legacy: false };
}

export {
  CHAIN_FILE_NAME,
  MANIFEST_FILE_NAME,
  INTEGRITY_RELEASE,
  INTEGRITY_VERSION,
  readNoFollow,
  runIntegrityOf,
  listRunFiles,
  checkRunFiles,
  checkFileHash,
  checkFilesUnder,
  SIGNATURE_FILE_NAME,
  CHAIN_LOCK_FILE_NAME,
  CHAIN_LOCK_STALE_MS,
  withChainLock,
  ed25519Key,
  signingKeyFingerprint,
  signManifest,
  verifyManifestSignature,
  checkSigningKey,
  integrityError,
  legacyRunNotice,
  legacyAfterVerifiedError,
  requiredFormatOf,
  INCREMENTALS_DIR_NAME,
  FULL_RUN_ID,
  INCREMENTAL_OVERLAP_SECONDS,
  RUN_ID_RE,
  BackupChainError,
  damagedRestoreMessage,
  deletedUserMessage,
  deletedUsersOf,
  readChain,
  writeChainAtomic,
  validateChain,
  newRunId,
  newChainId,
  recipientKeyFingerprint,
  chainEncryptionOf,
  bootstrapChainFromManifest,
  sinceByUser,
  listStrays,
  resolveRuns,
  runDirectory,
  readRunManifest,
  readEnvelope,
  checkRunEnvelope,
  isRealDirectory,
  readBackupBytes,
  runIdentityOf,
  planBackupRun,
  inspectBackup
};
export type { FileTable, RunIntegrity, ChainSigning, ManifestSignature, Chain, ChainRun, RunScope, DeletedUser, ChainEncryption, RunPlan, PlanOptions, InspectReport, InspectStatus };
