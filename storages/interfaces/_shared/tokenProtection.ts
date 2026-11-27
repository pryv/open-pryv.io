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
};

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
  probeTokensAtRest: () => Promise<{ columnsReady: boolean; clearRows: boolean }>;
  protectTokensAtRest: () => Promise<Record<string, number>>;
};

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
    if (!probe.clearRows) return;
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
