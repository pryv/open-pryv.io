/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Audit method ids of the developer space: the OAuth applications an account
 * registers and its publisher row (account API, recorded in the account's
 * own trail). Joined into the lists of ../ApiMethods.ts:
 * - all: every id (API methods and acts recorded directly);
 * - notAudited: ids of all that are never recorded (reads);
 * - withoutUser: recorded ids whose call has no account of this core in its context.
 *
 * Empty in this release: no method yet.
 */
export const all: readonly string[] = Object.freeze([]);
export const notAudited: readonly string[] = Object.freeze([]);
export const withoutUser: readonly string[] = Object.freeze([]);
