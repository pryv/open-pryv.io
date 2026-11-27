/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The contract the storage engines rely on to keep access tokens and personal
 * session ids out of the database in clear: a keyed hash (the lookup key) and
 * an encrypted copy (opened when an item is read). Built from the configuration
 * by `business/src/accesses/tokenProtection.ts` and injected at storage init.
 */
export type TokenProtection = {
  /** Identifies the key root: prefix of every hash. */
  kid: string;
  /** Whether a stored hash was computed under this key root. */
  ownsHash (storedHash: string | null | undefined): boolean;
  hashAccessToken (userId: string, token: string): string;
  sealAccessToken (userId: string, tokenHash: string, token: string): string;
  /** Throws (`name === 'TokenUnreadableError'`) when the envelope does not open. */
  openAccessToken (userId: string, tokenHash: string, tokenEnc: string): string;
  hashSessionId (id: string): string;
  sealSessionId (idHash: string, id: string): string;
  /** Throws (`name === 'TokenUnreadableError'`) when the envelope does not open. */
  openSessionId (idHash: string, idEnc: string): string;
  /** Whether a stored value is a sealed one (`sealed:<kid>.<envelope>`), under any key. */
  isSealed (stored: unknown): boolean;
  /** Whether a stored value is sealed under this key root. */
  ownsSealed (stored: unknown): boolean;
  /** The stored form of an access `integrity` value (bound to the user id). */
  sealAccessIntegrity (userId: string, integrity: string): string;
  /** Throws (`name === 'TokenUnreadableError'`) when the value does not open (tampered, another user, another key). */
  openAccessIntegrity (userId: string, stored: string): string;
  /** The stored form of a credential sent to another platform (bound to `context`). */
  sealSecret (context: string, value: string): string;
  /** Throws (`name === 'TokenUnreadableError'`) when the value does not open. */
  openSecret (context: string, stored: string): string;
};

/** Prefix of every sealed stored value (followed by the key id, a dot and the envelope). */
export const SEALED_PREFIX = 'sealed:';

/** Whether a stored value is a sealed one, under any key. */
export function isSealedValue (stored: unknown): stored is string {
  return typeof stored === 'string' && stored.startsWith(SEALED_PREFIX);
}

/**
 * The stored access `integrity` is sealed (a fresh envelope at each write): a
 * query can only test its presence. Any other condition on it (top level or
 * inside `$or`) is refused rather than silently matching nothing.
 */
export function refuseIntegrityValueCondition (query: Record<string, unknown> | null | undefined): void {
  const check = (q: Record<string, unknown> | null | undefined): void => {
    if (q == null || !Object.prototype.hasOwnProperty.call(q, 'integrity')) return;
    const v = q.integrity;
    if (v === null) return;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '$ne' && (v as Record<string, unknown>).$ne === null) return;
    }
    throw new TypeError('accesses: the stored integrity is sealed, a query takes `integrity: null` or `{ $ne: null }` only');
  };
  if (query == null) return;
  check(query);
  if (Array.isArray(query.$or)) for (const clause of query.$or as Array<Record<string, unknown>>) check(clause);
}

/**
 * Length of the key-id prefix of a stored hash (the key id and its dot), as
 * a plain integer for the probes' SQL: an index expression must repeat it
 * as a constant, so the PostgreSQL probe indexes use 9 (8-character key id).
 */
export function keyIdPrefixLength (kid: string): number {
  return Math.trunc(kid.length) + 1;
}

/**
 * From the smallest and the largest key-id prefix of the protected rows
 * (`lo`, `hi`; null when there is none): whether one row is under another
 * key than `kid`. Equal bounds mean every value between them is equal too.
 */
export function keyIdPrefixesForeign (bounds: { lo?: unknown; hi?: unknown } | undefined, kid: string): boolean {
  if (bounds == null || bounds.lo == null) return false;
  const own = kid + '.';
  return bounds.lo !== own || bounds.hi !== own;
}

/** Options of a whole-store read of accesses made for a report (the integrity check). */
export type ExportAccessesOptions = {
  /** Called for each row whose token does not open (`TokenUnreadableError`); the row is left out of the result. */
  onUnreadableRow?: (accessId: unknown, reason: string) => void;
};

/**
 * `toItem` over `rows`; a row whose token does not open is reported and left
 * out, any other error is thrown. Lookups never use this: they fail closed.
 */
export function itemsReportingUnreadable<R, T> (rows: R[], toItem: (row: R) => T, report: (accessId: unknown, reason: string) => void): T[] {
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(toItem(row));
    } catch (err) {
      if ((err as Error).name !== 'TokenUnreadableError') throw err;
      report((err as Error & { accessId?: unknown }).accessId, (err as Error).message);
    }
  }
  return out;
}

/** Thrown by a lookup or a boot check that meets rows protected under another key. */
export const FOREIGN_KEY_ERROR_NAME = 'ForeignTokenKeyError';

/** The operator message for rows protected under another key. */
export function foreignKeyMessage (where: string): string {
  return 'access tokens at rest: ' + where + ' are protected under another key than the configured one ' +
    '(auth.accessTokensKey, else auth.adminAccessKey changed?). Refusing to start: every token would be ' +
    'rejected. Restore the previous key, or run `node bin/access-tokens.js rekey --previous-key-file <path>` ' +
    'with the core stopped.';
}

/** A Error named `ForeignTokenKeyError`. */
export function foreignKeyError (where: string): Error {
  const err = new Error(foreignKeyMessage(where));
  err.name = FOREIGN_KEY_ERROR_NAME;
  return err;
}

/** The operator message for access rows a conversion left in clear. */
export function unconvertedAccessesMessage (count: number): string {
  return 'access tokens at rest: ' + count + ' access row(s) left in clear: each holds the same token as another ' +
    'live access of its user, so it cannot be looked up and its token stays in clear at rest. ' +
    '`node bin/access-tokens.js status` lists them (accessesInClear). Fix: delete one of the two accesses; ' +
    'the next start converts the other.';
}

/** The operator message when rows wait for the conversion and the start does not run it. */
export const CONVERSION_PENDING_MESSAGE = 'access tokens at rest: access tokens or session ids are stored in clear ' +
  'and cannot be looked up until they are converted (migrations.autoRunOnStart is false). Refusing to start: ' +
  'every token would be rejected. Run `node bin/migrate.js up`, then start.';

/** The passes of the base storage engine the start relies on (see `storages.getTokensAtRest`). */
type BootTokensAtRest = {
  /** `clearIntegrityOnly`: no token or session waits, but access `integrity` values are stored in clear. */
  probeTokensAtRest: () => Promise<{ columnsReady: boolean; clearRows: boolean; clearIntegrityOnly?: boolean }>;
  protectTokensAtRest: () => Promise<Record<string, number>>;
};

/** The warning when only access `integrity` values wait for the conversion (lookups unaffected). */
export const CLEAR_INTEGRITY_PENDING_MESSAGE = '[access-tokens-at-rest] access integrity values are still stored in clear ' +
  '(migrations.autoRunOnStart is false). Lookups are not affected; run `node bin/migrate.js up` to seal them.';

/**
 * What the master does before its workers serve. With `autoRun`: refuse rows
 * protected under another key, convert the rows in clear, warn about rows
 * left in clear. Without: refuse to start while rows wait for the conversion
 * (they would not be found), warn only while the schema migration itself is
 * pending (the existing pending-migration behaviour).
 */
export async function tokensAtRestAtBoot (opts: {
  tokensAtRest: BootTokensAtRest;
  autoRun: boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<void> {
  const { tokensAtRest, autoRun, log, warn } = opts;
  if (!autoRun) {
    const probe = await tokensAtRest.probeTokensAtRest();
    if (!probe.clearRows) {
      if (probe.clearIntegrityOnly === true) warn(CLEAR_INTEGRITY_PENDING_MESSAGE);
      return;
    }
    if (probe.columnsReady) throw new Error(CONVERSION_PENDING_MESSAGE);
    warn('[access-tokens-at-rest] access tokens or session ids are still stored in clear and cannot be ' +
      'looked up (autoRunOnStart=false, migration pending). Run `node bin/migrate.js up` to convert them.');
    return;
  }
  const res = await tokensAtRest.protectTokensAtRest();
  const changed = Object.entries(res).filter(([k, n]) => n > 0 && k !== 'accessesSkipped');
  if (changed.length > 0) log(`[access-tokens-at-rest] ${changed.map(([k, n]) => `${k}: ${n}`).join(', ')}`);
  const skipped = res.accessesSkipped ?? 0;
  if (skipped > 0) warn('[access-tokens-at-rest] ' + unconvertedAccessesMessage(skipped));
}
