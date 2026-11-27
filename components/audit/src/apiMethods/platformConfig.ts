/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Audit method ids of the platform-wide configuration held in the platform store.
 * Joined into the lists of ../ApiMethods.ts:
 * - all: every id (API methods and acts recorded directly);
 * - notAudited: ids of all that are never recorded (reads);
 * - withoutUser: recorded ids whose call has no account of this core in its context.
 */
export const all: readonly string[] = Object.freeze([
  'system.platformConfig.list',
  'system.platformConfig.get',
  'system.platformConfig.set',
  'system.platformConfig.delete'
]);
export const notAudited: readonly string[] = Object.freeze([
  'system.platformConfig.list',
  'system.platformConfig.get'
]);
export const withoutUser: readonly string[] = Object.freeze([
  'system.platformConfig.set',
  'system.platformConfig.delete'
]);
