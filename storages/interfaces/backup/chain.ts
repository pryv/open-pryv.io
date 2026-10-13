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
import { createBackupDecryptor, recipientKeyFingerprint } from './BackupCipher.ts';
import type { BackupDecryptor, DecryptorSecrets, Envelope } from './BackupCipher.ts';

const CHAIN_FILE_NAME = 'chain.json';
const INCREMENTALS_DIR_NAME = 'incrementals';
const MANIFEST_FILE_NAME = 'manifest.json';
const ENVELOPE_FILE_NAME = 'encryption.json';
const FULL_RUN_ID = 'full';
const CHAIN_FORMAT_VERSION = 1;
/** The first release that writes backup chains (named in the operator messages). */
const CHAIN_RELEASE = '2.0.0-rc.51';

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

type Chain = {
  formatVersion: number;
  chainId: string;
  encryption: ChainEncryption;
  runs: ChainRun[];
};

type BackupChainErrorCode = 'invalid' | 'exists' | 'damaged' | 'incomplete' | 'mismatch' | 'key-model' | 'secret' | 'deleted' | 'concurrent';

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

/** Read a (possibly encrypted) file of the backup without following a symbolic link. */
function readBackupBytes (filePath: string, decryptor: BackupDecryptor | null): Buffer {
  const raw = readNoFollow(filePath);
  return decryptor ? decryptor.decryptBuffer(raw) : raw;
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
function readRunManifest (root: string, dir: string, chain: Chain, run: ChainRun, previousRunId: string | null, decryptor: BackupDecryptor | null): Record<string, unknown> {
  const runDir = runDirectory(root, run);
  const manifestPath = runDir === '' ? '' : path.join(runDir, MANIFEST_FILE_NAME);
  if (runDir === '' || !existsNoFollow(manifestPath)) {
    throw new BackupChainError('incomplete', missingRunMessage(dir, run.runId, previousRunId, 'its manifest'));
  }
  const manifest = JSON.parse(readBackupBytes(manifestPath, decryptor).toString('utf8'));
  const pre = run.bootstrapped === true && manifest.chainId == null && manifest.runId == null;
  if (!pre && (manifest.chainId !== chain.chainId || manifest.runId !== run.runId || (manifest.parentRunId ?? null) !== (run.parentRunId ?? null))) {
    throw new BackupChainError('mismatch', `Run ${run.runId} of the backup chain at ${dir} does not belong to this chain (its manifest names another chain, run or parent run): refused.`);
  }
  return manifest;
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
      manifest = JSON.parse(readBackupBytes(path.join(dir, MANIFEST_FILE_NAME), decryptor).toString('utf8'));
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
        readBackupBytes(path.join(runDir, MANIFEST_FILE_NAME), decryptor);
      } catch (err) {
        throw new BackupChainError('secret', `The passphrase does not decrypt the existing backup chain at ${dir}: refused (nothing written).`);
      }
    }
  }

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

type InspectStatus = 'ok' | 'damaged' | 'incomplete' | 'unknown' | 'invalid';

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
function inspectBackup (dir: string, options: { secrets?: DecryptorSecrets } = {}): InspectReport {
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
    manifest = JSON.parse(readBackupBytes(manifestPath, decryptor).toString('utf8'));
  } catch (err) {
    return report('unknown', 'UNKNOWN: the manifest cannot be read (' + (err as Error).message + ')');
  }
  lines.push(`Manifest: ${String(manifest.backupType)}, snapshot ${isoOf(manifest.snapshotBefore)}, ${Array.isArray(manifest.users) ? manifest.users.length : 0} user(s)`);
  if (manifest.backupType === 'incremental') {
    lines.push(damagedRestoreMessage(dir));
    return report('damaged', 'DAMAGED: the root manifest says "incremental" and there is no chain.json');
  }
  return report('ok', `OK (full backup written before ${CHAIN_RELEASE}, one run)`);
}

export {
  CHAIN_FILE_NAME,
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
  planBackupRun,
  inspectBackup
};
export type { Chain, ChainRun, RunScope, DeletedUser, ChainEncryption, RunPlan, PlanOptions, InspectReport, InspectStatus };
