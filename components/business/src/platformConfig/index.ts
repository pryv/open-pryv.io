/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { isDeepStrictEqual } from 'node:util';
import { getLogger, PLATFORM_STORE_SCOPE } from '@pryv/boiler';
import { createValidator } from 'utils/src/jsonValidator.ts';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { SCHEMA, isValidKeyName } from './schema.ts';
import type { KeyDef, SchemaMap } from './schema.ts';

export { SCHEMA, NOT_IN_STORE, isValidKeyName } from './schema.ts';
export type { KeyDef, SchemaMap } from './schema.ts';

/**
 * Platform-wide configuration held in the platform store.
 *
 * A key of `SCHEMA` with a row in the store reads the row's value on every
 * core; a key without a row reads the configuration files and the
 * environment as before. The rows are loaded into the `platform-store` scope
 * of the configuration (above the files, the environment and the test
 * scope), so every `config.get()` returns the store value with no change at
 * the call site. Nothing is written at upgrade: a key moves to the store by an
 * explicit write and goes back to the files when its row is deleted.
 *
 * Rows (platform KV, replicated to every core):
 *
 * | Key                          | Value                                       |
 * |------------------------------|---------------------------------------------|
 * | `platform-config/<key>`      | `{ value, updatedAt, updatedBy }`           |
 * | `platform-config-rev`        | revision (integer), bumped by every change  |
 * | `core-config-rev/<coreId>`   | `{ rev, at }`: the revision a core's processes loaded last |
 *
 * Propagation: the process that writes reloads at once and tells the other
 * workers of its core (IPC, see `boot.ts`); every process polls the revision
 * each `platform.configPollSeconds` and reloads on a change.
 */

export const ROW_PREFIX = 'platform-config/';
export const REV_KEY = 'platform-config-rev';
export const CORE_REV_PREFIX = 'core-config-rev/';
export const SOURCE_LABEL = 'platform-db';
const DEFAULT_POLL_SECONDS = 15;
const MAX_POLL_SECONDS = 3600;
const UPDATE_ATTEMPTS = 8;
/** Waits between the attempts to bump the revision once a row landed. */
const BUMP_RETRY_DELAYS_MS = [50, 250, 1000];
/** The periodic check reloads unconditionally every this many checks (a missed bump heals). */
const DEFAULT_FULL_RELOAD_EVERY = 20;

export type KvStore = Pick<PlatformDB,
  'getPlatformKv' | 'setPlatformKv' | 'setPlatformKvIfAbsent' | 'replacePlatformKvIfValue' | 'listPlatformKvEntries'>;

/** What the module reads from the configuration (a boiler `Config`). */
export type ScopedConfig = {
  get (key: string): unknown;
  getLocal (key: string): unknown;
  replaceScopeConfig (scope: string, configObject: Record<string, unknown>): void;
};

export type UpdatedBy = { kind: 'session' | 'admin-key' | 'setup' | 'cli'; userId?: string; coreId: string };
export type Entry = { key: string; value: unknown; updatedAt: number; updatedBy: UpdatedBy };

const UPDATED_BY_KINDS: ReadonlySet<string> = new Set(['session', 'admin-key', 'setup', 'cli']);

export class UnknownKeyError extends Error {
  key: string;
  constructor (key: string) {
    super(`"${String(key)}" is not a platform configuration key the platform store may hold`);
    this.name = 'UnknownKeyError';
    this.key = key;
  }
}

export class InvalidValueError extends Error {
  key: string;
  errors: unknown[];
  constructor (key: string, errors: unknown[]) {
    super(`invalid value for the platform configuration key "${key}"`);
    this.name = 'InvalidValueError';
    this.key = key;
    this.errors = errors;
  }
}

export class ConcurrentChangeError extends Error {
  constructor (key: string) {
    super(`the platform store row ${key} kept changing under this update: retry`);
    this.name = 'ConcurrentChangeError';
  }
}

const logger = getLogger('platform-config');
const validator = createValidator();

// ---------------------------------------------------------------- schema

let activeSchema: SchemaMap = SCHEMA;

/** The keys the store may hold (SCHEMA, unless a test replaced it). */
export function schema (): SchemaMap {
  return activeSchema;
}

/** Tests only: replace the schema (null puts SCHEMA back). */
export function setSchemaForTests (s: SchemaMap | null): void {
  activeSchema = s ?? SCHEMA;
}

export function keyDef (key: string): KeyDef | null {
  return Object.prototype.hasOwnProperty.call(activeSchema, key) ? activeSchema[key] : null;
}

/** The configuration path of a key (`service.name` → `service:name`). */
export function configPath (key: string): string {
  return key.split('.').join(':');
}

/** The schema errors of `value` for `key`, or null when it is valid. */
export function valueErrors (key: string, value: unknown): unknown[] | null {
  const def = keyDef(key);
  if (def == null) throw new UnknownKeyError(key);
  if (value === undefined) return [{ code: 'VALUE_MISSING', message: 'a value is required', path: '#' }];
  if (validator.validate(value, def.schema) === true) return null;
  return validator.getLastErrors() ?? [];
}

function checkUpdatedBy (by: UpdatedBy): UpdatedBy {
  if (by == null || !UPDATED_BY_KINDS.has(by.kind) || typeof by.coreId !== 'string' || by.coreId === '') {
    throw new Error('updatedBy must be { kind: session | admin-key | setup | cli, userId?, coreId }');
  }
  const out: UpdatedBy = { kind: by.kind, coreId: by.coreId };
  if (by.userId != null) out.userId = String(by.userId);
  return out;
}

// ---------------------------------------------------------------- rows

/** A row as stored, or null when it is malformed. */
function parseRow (key: string, raw: string | null): Entry | null {
  if (raw == null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v == null || typeof v !== 'object' || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, 'value')) return null;
  const row = v as Record<string, unknown>;
  return {
    key,
    value: row.value,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    updatedBy: (row.updatedBy != null && typeof row.updatedBy === 'object' ? row.updatedBy : { kind: 'cli', coreId: 'unknown' }) as UpdatedBy
  };
}

function serialize (entry: Entry): string {
  return JSON.stringify({ value: entry.value, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy });
}

/** Every well-formed row of the family, schema or not, sorted by key. */
export async function listEntries (db: KvStore): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const { key, value } of await db.listPlatformKvEntries(ROW_PREFIX)) {
    const name = key.slice(ROW_PREFIX.length);
    const entry = parseRow(name, value);
    if (entry != null) out.push(entry);
  }
  return out.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export async function getEntry (db: KvStore, key: string): Promise<Entry | null> {
  if (!isValidKeyName(key)) return null;
  return parseRow(key, await db.getPlatformKv(ROW_PREFIX + key));
}

/** The revision of the family: 0 when nothing was ever written. */
export async function currentRev (db: KvStore): Promise<number> {
  const raw = await db.getPlatformKv(REV_KEY);
  const n = raw == null ? 0 : Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Compare-and-set loop over one row (insert-if-absent when missing, delete with null). */
async function casUpdate (db: KvStore, key: string, next: (raw: string | null) => string | null): Promise<{ before: string | null; after: string | null }> {
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
    const raw = await db.getPlatformKv(key);
    const out = next(raw);
    if (out === raw) return { before: raw, after: raw };
    const written = raw == null
      ? (out == null ? true : await db.setPlatformKvIfAbsent(key, out))
      : await db.replacePlatformKvIfValue(key, raw, out);
    if (written) return { before: raw, after: out };
  }
  throw new ConcurrentChangeError(key);
}

async function bumpRev (db: KvStore): Promise<number> {
  const { after } = await casUpdate(db, REV_KEY, (raw) => {
    const n = raw == null ? 0 : Number.parseInt(raw, 10);
    return String((Number.isSafeInteger(n) && n > 0 ? n : 0) + 1);
  });
  return Number.parseInt(after as string, 10);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Once a row landed: bumps the revision, retried with back-off. A failure is
 * logged and never thrown (the change is made; every process picks it up at
 * its next full reload, see startPolling). Answers the revision read back.
 */
async function bumpRevAfterWrite (db: KvStore, what: string): Promise<{ rev: number; revBumped: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return { rev: await bumpRev(db), revBumped: true };
    } catch (err) {
      if (attempt >= BUMP_RETRY_DELAYS_MS.length) {
        logger.error(`[platform-config-rev] ${what} written, but the revision was not bumped (${(err as Error).message}): processes load it at their next full reload`);
        break;
      }
      await sleep(BUMP_RETRY_DELAYS_MS[attempt]);
    }
  }
  let rev = 0;
  try { rev = await currentRev(db); } catch { /* answered as 0 */ }
  return { rev, revBumped: false };
}

/**
 * Writes the value of a key of the schema (validated, compare-and-set) and
 * bumps the revision. Throws UnknownKeyError, InvalidValueError, or a store
 * error when the row itself was not written; once the row is written it
 * answers (`revBumped: false` when the revision could not be bumped).
 */
export async function setEntry (db: KvStore, key: string, value: unknown, by: UpdatedBy): Promise<{ before: Entry | null; after: Entry; rev: number; revBumped: boolean }> {
  if (!isValidKeyName(key) || keyDef(key) == null) throw new UnknownKeyError(key);
  const errors = valueErrors(key, value);
  if (errors != null) throw new InvalidValueError(key, errors);
  const after: Entry = { key, value, updatedAt: Date.now(), updatedBy: checkUpdatedBy(by) };
  const raw = serialize(after);
  const done = await casUpdate(db, ROW_PREFIX + key, () => raw);
  const bumped = await bumpRevAfterWrite(db, `row "${key}"`);
  return { before: parseRow(key, done.before), after, ...bumped };
}

/**
 * Deletes the row of a key (the key reads the configuration files again) and
 * bumps the revision when there was one. A key outside the schema can be
 * deleted while a row of it is left in the store; otherwise UnknownKeyError.
 */
export async function unsetEntry (db: KvStore, key: string, by: UpdatedBy): Promise<{ before: Entry | null; rev: number; revBumped: boolean }> {
  checkUpdatedBy(by);
  if (!isValidKeyName(key)) throw new UnknownKeyError(key);
  const rowKey = ROW_PREFIX + key;
  if (keyDef(key) == null && await db.getPlatformKv(rowKey) == null) throw new UnknownKeyError(key);
  const done = await casUpdate(db, rowKey, () => null);
  if (done.before == null) return { before: null, rev: await currentRev(db), revBumped: false };
  return { before: parseRow(key, done.before), ...await bumpRevAfterWrite(db, `deletion of row "${key}"`) };
}

/**
 * Copies this core's current values of `keys` (default: every schema key)
 * into the store, only where no row exists (insert-if-absent). A key without
 * a local value, or whose local value the schema refuses, is skipped.
 */
export async function seed (config: ScopedConfig, db: KvStore, by: UpdatedBy, keys?: string[]): Promise<{ written: string[]; skipped: Array<{ key: string; reason: string }>; rev: number }> {
  const checkedBy = checkUpdatedBy(by);
  const names = keys ?? Object.keys(activeSchema).sort();
  const written: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  for (const key of names) {
    if (!isValidKeyName(key) || keyDef(key) == null) throw new UnknownKeyError(key);
    const value = config.getLocal(configPath(key));
    if (value === undefined) { skipped.push({ key, reason: 'no local value' }); continue; }
    if (valueErrors(key, value) != null) { skipped.push({ key, reason: 'the local value does not match the schema' }); continue; }
    const entry: Entry = { key, value, updatedAt: Date.now(), updatedBy: checkedBy };
    if (await db.setPlatformKvIfAbsent(ROW_PREFIX + key, serialize(entry))) written.push(key);
    else skipped.push({ key, reason: 'already in the store' });
  }
  const rev = written.length > 0 ? (await bumpRevAfterWrite(db, 'seed of ' + written.join(', '))).rev : await currentRev(db);
  return { written, skipped, rev };
}

// ---------------------------------------------------------------- scope

/** Why a row is not loaded, or null. */
function rowProblem (entry: Entry): string | null {
  if (!isValidKeyName(entry.key) || keyDef(entry.key) == null) return 'not a key of this release';
  const errors = valueErrors(entry.key, entry.value);
  return errors == null ? null : 'value refused by the schema';
}

function setPath (tree: Record<string, unknown>, key: string, value: unknown): void {
  const segments = key.split('.');
  let node = tree;
  for (const seg of segments.slice(0, -1)) {
    const child = node[seg];
    if (child == null || typeof child !== 'object' || Array.isArray(child)) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

/** Skipped rows already reported by this process (`<key>|<reason>`): once each. */
const reportedRows = new Set<string>();

/** The rows of the schema keys whose value the schema accepts. */
async function loadableEntries (db: KvStore, warn: boolean): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const entry of await listEntries(db)) {
    const problem = rowProblem(entry);
    if (problem != null) {
      if (warn && !reportedRows.has(entry.key + '|' + problem)) {
        reportedRows.add(entry.key + '|' + problem);
        logger.warn(`[platform-config-invalid] row "${entry.key}" skipped (${problem}): the local value stays`);
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

let loaded: { rev: number; keys: string[] } | null = null;
let reloadChain: Promise<unknown> = Promise.resolve();

/** The revision recorded for a core (`core-config-rev/<coreId>`), null when none or malformed. */
async function recordedRev (db: KvStore, coreId: string): Promise<number | null> {
  const raw = await db.getPlatformKv(CORE_REV_PREFIX + coreId);
  try {
    const v = JSON.parse(raw ?? 'null');
    return v != null && Number.isSafeInteger(v.rev) ? v.rev : null;
  } catch {
    return null;
  }
}

/** What this process loaded last, or null before the first load. */
export function loadedState (): { rev: number; keys: string[] } | null {
  return loaded;
}

/**
 * Fills the `platform-store` scope of the configuration with the valid rows
 * (an unknown or invalid row is skipped with a warning) and records the
 * revision this core runs (`core-config-rev/<coreId>`) when the recorded one
 * differs; nothing is written while the store holds no row and was never
 * written (an upgrade writes nothing). Loads run one at a time in a process.
 */
export async function loadScope (config: ScopedConfig, db: KvStore, coreId: string): Promise<{ rev: number; keys: string[] }> {
  const run = reloadChain.then(async () => {
    // The revision first: a change landing during the read bumps it after, so the next poll reloads.
    const rev = await currentRev(db);
    const tree: Record<string, unknown> = {};
    const keys: string[] = [];
    for (const entry of await loadableEntries(db, true)) {
      setPath(tree, entry.key, entry.value);
      keys.push(entry.key);
    }
    config.replaceScopeConfig(PLATFORM_STORE_SCOPE, tree);
    loaded = { rev, keys };
    if (rev !== 0 || keys.length > 0) {
      try {
        if (await recordedRev(db, coreId) !== rev) await db.setPlatformKv(CORE_REV_PREFIX + coreId, JSON.stringify({ rev, at: Date.now() }));
      } catch (err) {
        logger.warn(`could not record the configuration revision of core ${coreId}: ${(err as Error).message}`);
      }
    }
    return { rev, keys };
  });
  reloadChain = run.catch(() => {});
  return await run;
}

/** `platform.configPollSeconds`, within 1 to 3600 (default 15). */
export function pollSeconds (config: Pick<ScopedConfig, 'get'>): number {
  const v = config.get('platform:configPollSeconds');
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_POLL_SECONDS ? v : DEFAULT_POLL_SECONDS;
}

/**
 * Checks the revision every `platform.configPollSeconds` and reloads the
 * scope when it changed, and unconditionally every `fullReloadEvery` checks
 * (default 20), so a row written without its revision bump is still loaded.
 * The timer does not keep the process alive; a failed check keeps the values
 * loaded and is logged once until a check succeeds.
 */
export function startPolling (config: ScopedConfig, db: KvStore, coreId: string,
  onChange?: (state: { rev: number; keys: string[] }) => void, options: { fullReloadEvery?: number } = {}): () => void {
  const fullReloadEvery = options.fullReloadEvery ?? DEFAULT_FULL_RELOAD_EVERY;
  let busy = false;
  let failing = false;
  let checks = 0;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      checks++;
      const rev = await currentRev(db);
      const changed = loaded == null || rev !== loaded.rev;
      if (changed || checks % fullReloadEvery === 0) {
        const state = await loadScope(config, db, coreId);
        if (changed && onChange != null) onChange(state);
      }
      failing = false;
    } catch (err) {
      if (!failing) logger.warn('platform configuration check failed (the values loaded are kept): ' + (err as Error).message);
      failing = true;
    } finally {
      busy = false;
    }
  }, pollSeconds(config) * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Rows that hide a different local value (files, environment) on this core. */
export async function localOverrides (config: ScopedConfig, db: KvStore): Promise<Array<{ key: string; local: unknown }>> {
  const out: Array<{ key: string; local: unknown }> = [];
  for (const entry of await loadableEntries(db, false)) {
    const local = config.getLocal(configPath(entry.key));
    if (local !== undefined && !isDeepStrictEqual(local, entry.value)) out.push({ key: entry.key, local });
  }
  return out;
}

/**
 * The cores of `coreIds` whose processes did not load the current revision
 * (`rev` null: never recorded). The record of a core is the last one any of
 * its processes wrote: a core with one lagging process can read as current.
 */
export async function coresBehind (db: KvStore, coreIds: string[]): Promise<Array<{ coreId: string; rev: number | null }>> {
  const current = await currentRev(db);
  const out: Array<{ coreId: string; rev: number | null }> = [];
  for (const coreId of coreIds) {
    const rev = await recordedRev(db, coreId);
    if (rev == null ? current > 0 : rev < current) out.push({ coreId, rev });
  }
  return out;
}
