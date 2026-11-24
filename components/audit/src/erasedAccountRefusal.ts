/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * How the audit storages refuse a record of an account that is erased: the
 * per-user files (`ErasedUserError`, code `USER_ERASED`) and PostgreSQL rows
 * of an id the users index does not hold (SQLSTATE `PU001`). Literals, so the
 * audit component loads no storage engine; a test pins them to their sources.
 */
const ERASED_USER_ERROR_NAME = 'ErasedUserError';
const ERASED_USER_CODE = 'USER_ERASED';
const UNINDEXED_USER_CODE = 'PU001';

/** True for such a refusal, possibly wrapped. */
function isErasedAccountRefusal (err: unknown): boolean {
  for (let e = err, depth = 0; e != null && depth < 5; depth++) {
    const x = e as { name?: unknown; code?: unknown; innerError?: unknown; cause?: unknown };
    if (x.name === ERASED_USER_ERROR_NAME || x.code === ERASED_USER_CODE || x.code === UNINDEXED_USER_CODE) return true;
    e = x.innerError ?? x.cause;
  }
  return false;
}

export { isErasedAccountRefusal, ERASED_USER_ERROR_NAME, ERASED_USER_CODE, UNINDEXED_USER_CODE };
