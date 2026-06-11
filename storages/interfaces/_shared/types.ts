/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared types used across storages/interfaces/.
 *
 * Extracted to deduplicate inline declarations that previously lived
 * in 3+ interface files (Callback in Sessions, PasswordResetRequests,
 * UserStorage; UserOrId in UserStorage).
 */

/** Node-style callback shape used by every legacy interface method that
 *  returns its result via `(err, result)` instead of a Promise. */
export type Callback<T = unknown> = (err: Error | null, result?: T) => void;

/** A user reference accepted by interface methods that key on user identity.
 *  Either the bare user id string, or an object containing it. */
export type UserOrId = string | { id: string };
