/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Audit method ids of the OAuth client and publisher review.
 * Joined into the lists of ../ApiMethods.ts:
 * - all: every id (API methods and acts recorded directly);
 * - notAudited: ids of all that are never recorded (reads);
 * - withoutUser: recorded ids whose call has no account of this core in its context.
 *
 * `oauth.client.reviewed` and `oauth.publisher.reviewed` are rows of the
 * client owner's / the publisher's own trail (emitted directly via
 * audit.eventForUser() when that account is on the core where the act ran).
 */
export const all: readonly string[] = Object.freeze([
  'system.oauthClients.list',
  'system.oauthClients.get',
  'system.oauthClients.approve',
  'system.oauthClients.unvalidate',
  'system.oauthClients.suspend',
  'system.oauthClients.resume',
  'system.publishers.list',
  'system.publishers.get',
  'system.publishers.set',
  'oauth.client.reviewed',
  'oauth.publisher.reviewed'
]);
export const notAudited: readonly string[] = Object.freeze([
  'system.oauthClients.list',
  'system.oauthClients.get',
  'system.publishers.list',
  'system.publishers.get'
]);
export const withoutUser: readonly string[] = Object.freeze([
  'system.oauthClients.approve',
  'system.oauthClients.unvalidate',
  'system.oauthClients.suspend',
  'system.oauthClients.resume',
  'system.publishers.set'
]);
