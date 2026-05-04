/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * MFA routes. Plan 26: HTTP bindings for the mfa.* API methods.
 *
 * Route pattern summary:
 *
 *   POST /{username}/mfa/activate     — Authorization = personal token   → mfa.activate
 *   POST /{username}/mfa/confirm      — Authorization = mfaToken         → mfa.confirm
 *   POST /{username}/mfa/challenge    — Authorization = mfaToken         → mfa.challenge
 *   POST /{username}/mfa/verify       — Authorization = mfaToken         → mfa.verify
 *   POST /{username}/mfa/deactivate   — Authorization = personal token   → mfa.deactivate
 *   POST /{username}/mfa/recover      — no auth                          → mfa.recover
 *
 * `initContextMiddleware` already ran from `routes/root.js` for any
 * `/:username/*` path — `req.context.user` is populated from the URL. For the
 * personal-token methods we then run `loadAccessMiddleware` so the method
 * implementations see `context.access.type === 'personal'`. For the
 * mfaToken-bound methods we skip `loadAccess` (the mfaToken is not a real Pryv
 * access token) and pass the raw token value through as `params.mfaToken`; the
 * API method looks it up in the in-memory SessionStore.
 */

const middleware = require('middleware');
const { setMethodId } = require('middleware');
const methodCallback = require('./methodCallback');
const Paths = require('./Paths');

module.exports = function (expressApp, app) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // --- Personal-token routes --------------------------------------------
  expressApp.post(Paths.MFA + '/activate',
    setMethodId('mfa.activate'),
    loadAccessMiddleware,
    function routeMFAActivate (req, res, next) {
      api.call(req.context, req.body || {}, methodCallback(res, next, 302));
    });

  expressApp.post(Paths.MFA + '/deactivate',
    setMethodId('mfa.deactivate'),
    loadAccessMiddleware,
    function routeMFADeactivate (req, res, next) {
      api.call(req.context, {}, methodCallback(res, next, 200));
    });

  // --- mfaToken-bound routes --------------------------------------------
  expressApp.post(Paths.MFA + '/confirm',
    setMethodId('mfa.confirm'),
    function routeMFAConfirm (req, res, next) {
      const params = Object.assign({}, req.body || {}, { mfaToken: extractToken(req) });
      api.call(req.context, params, methodCallback(res, next, 200));
    });

  expressApp.post(Paths.MFA + '/challenge',
    setMethodId('mfa.challenge'),
    function routeMFAChallenge (req, res, next) {
      api.call(req.context, { mfaToken: extractToken(req) }, methodCallback(res, next, 200));
    });

  expressApp.post(Paths.MFA + '/verify',
    setMethodId('mfa.verify'),
    function routeMFAVerify (req, res, next) {
      const params = Object.assign({}, req.body || {}, { mfaToken: extractToken(req) });
      api.call(req.context, params, methodCallback(res, next, 200));
    });

  // --- Unauth route -----------------------------------------------------
  expressApp.post(Paths.MFA + '/recover',
    setMethodId('mfa.recover'),
    function routeMFARecover (req, res, next) {
      api.call(req.context, req.body || {}, methodCallback(res, next, 200));
    });
};

/**
 * Extract the mfaToken from the Authorization header. Accepts `<token>` or
 * `Bearer <token>` shapes. Returns null if the header is missing — the API
 * method will then reject via schema validation.
 */
function extractToken (req) {
  const raw = req.headers && req.headers.authorization;
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') return parts[1];
  return raw.trim();
}
