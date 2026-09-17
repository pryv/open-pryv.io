/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike, PryvRequest } from '../_types.ts';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
/**
 * OAuth-style access authorization routes.
 * Implements the polling flow: create request → poll → accept/refuse.
 *
 * POST /reg/access       — create access request, return polling key
 * GET  /reg/access/:key  — poll access state
 * POST /reg/access/:key  — update state (ACCEPTED/REFUSED)
 */

const accessState = require('./accessState.ts');
const { resolveConsentSidecar } = require('business/src/accesses/consentSidecar.ts');
const { checkAcceptedGrant } = require('./consentCheck.ts');
const { getLogger } = require('@pryv/boiler');

const logger = getLogger('routes:reg:access');

/** Operator- and developer-facing wording for each grant refusal. The
 * reason id in `data.reason` is the machine-readable form; this is what a
 * person reads in a console. */
function consentGrantMessage (reason: string): string {
  switch (reason) {
    case 'token-invalid':
      return 'The posted token does not resolve to an access on this platform.';
    case 'not-app-access':
      return 'The posted token must belong to an app access created for this request.';
    case 'empty-grant':
      return 'The access grants nothing that was offered; refuse the request instead.';
    case 'choice-not-allowed':
      return 'This consent is all-or-nothing: the access must carry every offered permission.';
    case 'mandatory-refused':
      return 'Permissions the app marked as mandatory are missing from the access.';
    default:
      return 'The access carries permissions that were not offered to the user.';
  }
}

/**
 * Whether `candidate` (a caller-supplied auth-page URL) matches one of the
 * operator-configured `access:trustedAuthUrls` entries.
 *
 * An entry trusts: same protocol + same host(:port), and the candidate's
 * pathname must equal the entry's pathname or extend it on a `/` segment
 * boundary (so `https://a.com/auth` doesn't trust `https://a.com/auth-evil`,
 * and `https://a.com` doesn't trust `https://a.com.evil.io`). Query strings
 * are free — the page itself is what's being trusted. URLs carrying
 * credentials (`user:pass@`) are rejected outright.
 */
function isTrustedAuthUrl (candidate: string, trustedEntries: unknown): boolean {
  if (!Array.isArray(trustedEntries) || trustedEntries.length === 0) return false;
  let url: URL;
  try { url = new URL(candidate); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username !== '' || url.password !== '') return false;
  for (const entry of trustedEntries) {
    if (typeof entry !== 'string') continue;
    let trusted: URL;
    try { trusted = new URL(entry); } catch { continue; }
    if (trusted.protocol !== url.protocol) continue;
    if (trusted.host !== url.host) continue; // host includes the port
    if (url.pathname === trusted.pathname) return true;
    const prefix = trusted.pathname.endsWith('/') ? trusted.pathname : trusted.pathname + '/';
    if (url.pathname.startsWith(prefix)) return true;
  }
  return false;
}

/** Default life of a decided request after a poll first reads it. */
const DEFAULT_TERMINAL_RETENTION_MS = 120 * 1000;

export default function (expressApp: ExpressApp, app: AppLike) {
  // Read per request, so a config change (or a test override) applies.
  // 0 disables the shortening: the state then lives its full request TTL.
  function terminalRetentionMs (): number {
    const value = app.config.get('access:terminalRetentionMs');
    return typeof value === 'number' && value >= 0 ? value : DEFAULT_TERMINAL_RETENTION_MS;
  }

  /**
   * POST /reg/access — Create a new access request.
   */
  expressApp.post('/reg/access', async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { requestingAppId, requestedPermissions } = req.body;

      if (!requestingAppId || typeof requestingAppId !== 'string') {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'Missing or invalid requestingAppId' }
        });
      }
      if (!Array.isArray(requestedPermissions) || requestedPermissions.length === 0) {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'Missing or invalid requestedPermissions' }
        });
      }

      // The optional `consent` sidecar carries the per-entry annotations
      // (`mandatory`, `optIn`) beside the plain entries, and is resolved
      // here into the consent form the auth page and the ACCEPTED check
      // both read. A request without it runs no new validation and is
      // processed exactly as it was before consent forms existed.
      let consentForm;
      // `!= null`, not `!== undefined`: a client that serialises an absent
      // option as `null` degrades on an older core (which ignores the
      // unknown field) and must not fail here instead.
      if (req.body.consent != null) {
        try {
          consentForm = resolveConsentSidecar(requestedPermissions, req.body.consent);
        } catch (err: unknown) {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: (err as Error)?.message ?? String(err) }
          });
        }
      }

      const { key, state, expiresAt } = accessState.buildState({ ...req.body, consent: consentForm });

      // Build poll URL from the LOCAL core's URL — accessState is stored
      // per core (core-local store, never replicated), so every poll GET
      // must hit the same core that served the POST. Using the
      // cluster-wide `service.register` URL (e.g. https://reg.pryv.me/...)
      // would round-robin across cores and cause `unknown-access-key`.
      //
      const serviceInfo = (app.config.get('service') || {}) as Record<string, unknown> & { register?: string; api?: string };
      const coreUrl = app.config.get('core:url') as string | undefined;
      // core:url may be operator-supplied with or without trailing slash;
      // normalize so we don't emit `https://core.x//reg/...`.
      let coreUrlSlash = coreUrl
        ? (coreUrl.endsWith('/') ? coreUrl : coreUrl + '/')
        : null;
      // Multi-core without an explicit core:url (DNS-derived core URLs):
      // the register URL spans every core, so derive this core's own URL.
      if (coreUrlSlash == null && app.config.get('core:isSingleCore') === false) {
        const { getPlatform } = require('platform');
        const platform = await getPlatform();
        const self = platform.coreIdToUrl(platform.coreId);
        if (typeof self === 'string' && /^https?:\/\//.test(self)) coreUrlSlash = self;
      }
      const pollBase = coreUrlSlash ? coreUrlSlash + 'reg/' : (serviceInfo.register || '/reg/');
      const pollUrl = pollBase + 'access/' + key;

      // Build the popup auth-UI URL as `authUrl`. SDKs open this in a popup
      // for the user to sign in. Base URL comes from `access.defaultAuthUrl`
      // in config — operators deploy app-web-user-account (or an equivalent
      // auth UI) at that address and set the config.
      //
      // Apps may request their OWN auth page via `authUrl` in the body —
      // honored only when it matches an operator-configured
      // `access:trustedAuthUrls` entry (this endpoint is unauthenticated;
      // an open `authUrl` passthrough would be a phishing/redirect vector).
      // An untrusted value is rejected loudly rather than silently falling
      // back: silent behaviour here has already cost integrators debugging
      // sessions.
      const defaultAuthUrl = app.config.get('access:defaultAuthUrl') as string | undefined;
      let authUrlBase = defaultAuthUrl;
      const clientAuthUrl = req.body.authUrl;
      if (clientAuthUrl != null) {
        const trustedAuthUrls = app.config.get('access:trustedAuthUrls');
        if (typeof clientAuthUrl !== 'string' || !isTrustedAuthUrl(clientAuthUrl, trustedAuthUrls)) {
          return res.status(400).json({
            error: {
              id: 'invalid-parameters',
              message: 'authUrl does not match any access:trustedAuthUrls entry' +
                (Array.isArray(trustedAuthUrls) && trustedAuthUrls.length > 0 ? '' : ' (none configured)')
            }
          });
        }
        authUrlBase = clientAuthUrl;
      }
      let authUrl: string | null = null;
      if (authUrlBase) {
        const sep = authUrlBase.indexOf('?') >= 0 ? '&' : '?';
        const params = [
          'lang=' + encodeURIComponent(req.body.languageCode || 'en'),
          'key=' + encodeURIComponent(key),
          'requestingAppId=' + encodeURIComponent(requestingAppId),
          'poll=' + encodeURIComponent(pollUrl),
          'poll_rate_ms=' + state.poll_rate_ms,
          'serviceInfo=' + encodeURIComponent(serviceInfo.api ? (serviceInfo.register || '') + 'service/info' : '')
        ];
        if (state.returnURL) params.push('returnURL=' + encodeURIComponent(state.returnURL));
        if (state.oauthState) params.push('oauthState=' + encodeURIComponent(state.oauthState));
        authUrl = authUrlBase + sep + params.join('&');
      }

      // Stash pollUrl + authUrl on state so GET /reg/access/:key can echo
      // them back verbatim (lib-js rehydrates state from the poll body).
      state.pollUrl = pollUrl;
      state.authUrl = authUrl;
      // Persist the fully-built state once — buildState only prepared the
      // shape; we write it here, after the URLs are computed.
      await accessState.persist(key, state, expiresAt);

      // Calling-app surface: only the fields the SDK needs to drive
      // the flow. The auth UI gets richer state from GET /reg/access/:key
      // (and from query parameters on `authUrl`). Service metadata
      // belongs at `/service/info` — clients fetch it from there.
      const created: Record<string, unknown> = {
        status: state.status,
        key,
        authUrl,
        poll: pollUrl,
        poll_rate_ms: state.poll_rate_ms
      };
      // Echoed ONLY for an annotated request. This is also the app's
      // detection signal: a server that understood the sidecar says so
      // here, an older one simply does not, and the flow degrades to
      // all-or-nothing rather than failing.
      if (state.consent !== undefined) created.consent = state.consent;
      res.status(201).json(created);
    } catch (err) { next(err); }
  });

  /**
   * GET /reg/access/:key — Poll access request state.
   */
  expressApp.get('/reg/access/:key', async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const state = await accessState.get(req.params.key);
      if (!state) {
        return res.status(400).json({
          error: { id: 'unknown-access-key', message: 'Unknown or expired access key' }
        });
      }

      const response: Record<string, unknown> = {
        status: state.status
      };

      if (state.status === 'NEED_SIGNIN') {
        // Embed service metadata only on NEED_SIGNIN polls — that's where
        // the auth UI loads it during init. Later polls (lib-js polling
        // for ACCEPTED) don't need it; clients can hit `/service/info`
        // directly.
        response.serviceInfo = app.config.get('service') || {};
        response.key = state.key;
        response.requestingAppId = state.requestingAppId;
        response.requestedPermissions = state.requestedPermissions;
        response.poll = state.pollUrl || null;
        response.authUrl = state.authUrl || null;
        response.poll_rate_ms = state.poll_rate_ms;
        response.lang = state.languageCode || 'en';
        response.returnURL = state.returnURL;
        response.oauthState = state.oauthState;
        response.clientData = state.clientData;
        // Only for an annotated request, and absent (not null) otherwise,
        // so an un-annotated poll body is unchanged byte for byte and an
        // auth page that does not know the field keeps working:
        // `requestedPermissions` above stays plain and complete.
        if (state.consent !== undefined) response.consent = state.consent;
      } else if (state.status === 'ACCEPTED') {
        response.username = state.username;
        response.token = state.token;
        response.apiEndpoint = state.apiEndpoint;
      } else if (state.status === 'REFUSED' || state.status === 'ERROR') {
        response.reasonId = state.reasonId;
        response.message = state.message;
      } else if (state.status === 'REDIRECTED') {
        // Multi-core: auth moved to another core; the SDK follows the
        // new poll URL. The auth UI receives the same field via the
        // POST update response and redirects the browser.
        response.poll = state.redirectUrl;
        response.redirectUrl = state.redirectUrl;
      }

      // First read of a decided outcome starts the retention window: the
      // credential stays readable briefly (clients poll it more than once),
      // then the key is gone, instead of lingering for the full request TTL.
      await accessState.markDelivered(req.params.key, state, terminalRetentionMs());

      res.status(state.code).json(response);
    } catch (err) { next(err); }
  });

  /**
   * POST /reg/access/:key — Update access request (accept or refuse).
   */
  expressApp.post('/reg/access/:key', async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { status } = req.body;

      if (!status || !['ACCEPTED', 'REFUSED', 'ERROR', 'REDIRECTED'].includes(status)) {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'status must be ACCEPTED, REFUSED, ERROR, or REDIRECTED' }
        });
      }

      if (status === 'ACCEPTED') {
        // Types, not just presence: these two are used to look up an access,
        // and a non-string would fault deep in the loader rather than being
        // reported as the malformed request it is.
        if (typeof req.body.username !== 'string' || req.body.username === '' ||
            typeof req.body.token !== 'string' || req.body.token === '') {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: 'ACCEPTED requires username and token' }
          });
        }
      }

      if (status === 'REDIRECTED') {
        if (!req.body.redirectUrl) {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: 'REDIRECTED requires redirectUrl' }
          });
        }
      }

      // A request created with a consent form is the only one whose
      // ACCEPTED is checked: the server reads the access the page just
      // minted and asks whether it matches what the user was offered.
      // Without a form there is nothing to check against (the rule would
      // be "grant everything"), so the endpoint keeps its long-standing
      // opaque-token contract for every other integrator UI.
      if (status === 'ACCEPTED') {
        const pending = await accessState.get(req.params.key);
        if (pending?.consent != null) {
          const outcome = await checkAcceptedGrant({
            app,
            username: req.body.username,
            token: req.body.token,
            consentForm: pending.consent
          });
          if (!outcome.ok && outcome.kind === 'grant') {
            // The state is deliberately left untouched: still NEED_SIGNIN,
            // so the page can correct the grant and post again.
            return res.status(400).json({
              error: {
                id: 'invalid-consent-grant',
                message: consentGrantMessage(outcome.reason),
                data: {
                  reason: outcome.reason,
                  ...(outcome.offending != null ? { offending: outcome.offending } : {})
                }
              }
            });
          }
          if (!outcome.ok) {
            // Could not perform the check. Never a pass (that would be a
            // consent bypass) and never an opaque 500: the operator is
            // told which of the three it was, in the log and in the body.
            logger.error('consent check unavailable on access request ' + req.params.key +
              ' (' + outcome.reason + '): ' + (outcome.detail ?? ''));
            return res.status(503).json({
              error: {
                id: 'consent-check-unavailable',
                message: 'The consent grant could not be verified by this server. ' +
                  'The access request is unchanged; retry shortly.',
                data: { reason: outcome.reason }
              }
            });
          }
        }
      }

      const state = await accessState.update(req.params.key, req.body);
      if (!state) {
        return res.status(400).json({
          error: { id: 'unknown-access-key', message: 'Unknown or expired access key' }
        });
      }

      const response: Record<string, unknown> = {
        status: state.status
      };
      if (state.status === 'ACCEPTED') {
        response.username = state.username;
        response.token = state.token;
        response.apiEndpoint = state.apiEndpoint;
      } else if (state.status === 'REFUSED' || state.status === 'ERROR') {
        response.reasonId = state.reasonId;
        response.message = state.message;
      } else if (state.status === 'REDIRECTED') {
        response.poll = state.redirectUrl;
        response.redirectUrl = state.redirectUrl;
      }
      res.status(state.code).json(response);
    } catch (err) { next(err); }
  });

  /**
   * POST /access/invitationtoken/check — Check validity of an invitation token.
   * Returns plain text 'true' or 'false'.
   */
  expressApp.post('/access/invitationtoken/check', async (req: PryvRequest, res: Response) => {
    const token = req.body.invitationtoken;
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    const isValid = await platform.isInvitationTokenValid(token);
    res.type('text/plain').send(isValid ? 'true' : 'false');
  });
};
