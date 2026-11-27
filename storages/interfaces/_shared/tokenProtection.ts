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
