/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OADT] OAuth2 audit classification — lock-step guard.
 *
 * Regression cover for the class of defect where the user-less oauth events
 * are declared in one place (oauth2 USERLESS_EVENTS) but the mirroring entries
 * in the audit component (WITHOUT_USER_METHODS) are forgotten. When that
 * happens the user-less events fall into per-user storage and every emission
 * hits storage.forUser(undefined) — silently lost with a per-event error log.
 * These assertions fail loudly on any drift between the two lists.
 */

const assert = require('node:assert/strict');
const { USERLESS_EVENTS } = require('../src/audit.ts');
const { ALL_METHODS, WITHOUT_USER_METHODS } = require('audit/src/ApiMethods.ts');

const OAUTH_EVENTS = [
  'oauth.consent.shown',
  'oauth.consent.granted',
  'oauth.consent.refused',
  'oauth.code.exchanged',
  'oauth.code.reused',
  'oauth.token.issued.authorization_code',
  'oauth.token.issued.client_credentials',
  'oauth.token.refreshed',
  'oauth.token.revoked'
];

describe('[OADT] OAuth2 audit event classification', () => {
  it('[OADT1] every oauth.* event is registered in the audit ALL_METHODS list', () => {
    for (const e of OAUTH_EVENTS) {
      assert.ok(ALL_METHODS.includes(e),
        `${e} must be in audit ApiMethods.ALL_METHODS (else AuditFilter.isAudited returns undefined and eventForUser throws)`);
    }
  });

  it('[OADT2] every USERLESS_EVENTS entry is in WITHOUT_USER_METHODS (else it hits storage.forUser(undefined))', () => {
    for (const e of USERLESS_EVENTS) {
      assert.ok(WITHOUT_USER_METHODS.includes(e),
        `${e} is user-less but missing from audit WITHOUT_USER_METHODS — it would be routed to per-user storage with no userId`);
    }
  });

  it('[OADT3] the oauth.* entries in WITHOUT_USER_METHODS exactly match USERLESS_EVENTS (no drift either way)', () => {
    const oauthWithoutUser = WITHOUT_USER_METHODS.filter((m) => m.startsWith('oauth.')).sort();
    const userless = [...USERLESS_EVENTS].sort();
    assert.deepEqual(oauthWithoutUser, userless);
  });

  it('[OADT4] user-scoped oauth events are NOT in WITHOUT_USER_METHODS (so they persist to per-user storage)', () => {
    const userScoped = OAUTH_EVENTS.filter((e) => !USERLESS_EVENTS.has(e));
    // sanity: client_credentials resolves the app-account userId, so it is user-scoped
    assert.ok(userScoped.includes('oauth.token.issued.client_credentials'));
    for (const e of userScoped) {
      assert.ok(!WITHOUT_USER_METHODS.includes(e),
        `${e} is user-scoped and must NOT be in WITHOUT_USER_METHODS (or its rows would never reach storage)`);
    }
  });
});
