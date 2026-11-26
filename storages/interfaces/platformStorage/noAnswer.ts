/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/** The `name` of the error the rqlite engine throws for a statement it got no answer to. */
export const PLATFORM_NO_ANSWER_ERROR_NAME = 'RqliteNoAnswerError';

/**
 * True when `err`, or an error it wraps (`innerError`, `cause`), is a platform
 * statement that got no answer (no leader, leader unreachable, platform
 * database not reachable): not a "no row", not a defect; a retry later is
 * correct. Recognised by name, so callers need not import the engine.
 */
export function isPlatformNoAnswer (err: unknown): boolean {
  for (let e = err, depth = 0; e != null && depth < 5; depth++) {
    const x = e as { name?: unknown; innerError?: unknown; cause?: unknown };
    if (x.name === PLATFORM_NO_ANSWER_ERROR_NAME) return true;
    e = x.innerError ?? x.cause;
  }
  return false;
}
