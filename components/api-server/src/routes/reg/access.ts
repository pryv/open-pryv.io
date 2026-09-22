/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike, PryvRequest } from '../_types.ts';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
import * as sharedSecrets from 'shared-secrets';
import { createHandoff, parseHandoffField, tokenlessEndpointError } from './credentialHandoff.ts';
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
const ErrorIds = require('errors').ErrorIds;
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

const { USERNAME_REGEXP_STR } = require('../../schema/helpers.ts');
const USERNAME_RE = new RegExp(USERNAME_REGEXP_STR);

/**
 * `actAs` on a new request: 'allow', 'deny', or the username to preselect.
 * Returns an error message, or null when valid.
 */
function actAsError (actAs: unknown): string | null {
  if (actAs === 'allow' || actAs === 'deny') return null;
  if (typeof actAs === 'string' && USERNAME_RE.test(actAs)) return null;
  return 'actAs must be "allow", "deny" or a username';
}

type DelegationHint = {
  isDelegatedAccess: true;
  controlledUsername: string;
  delegate: { username: string; hostSlug?: string };
};

function isShortString (value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 256;
}

/**
 * The `delegation` display hint an auth page posts with ACCEPTED when it
 * granted the access on an account the user controls. Only the known keys
 * are accepted and `controlledUsername` must name the account the access
 * lives on. Returns a clean copy, or an error message.
 */
function parseDelegationHint (value: unknown, username: unknown): DelegationHint | string {
  const message = 'delegation must be { isDelegatedAccess: true, controlledUsername, delegate: { username, hostSlug? } }';
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return message;
  const hint = value as Record<string, unknown>;
  if (Object.keys(hint).some((k) => !['isDelegatedAccess', 'controlledUsername', 'delegate'].includes(k))) return message;
  if (hint.isDelegatedAccess !== true || !isShortString(hint.controlledUsername)) return message;
  const delegate = hint.delegate as Record<string, unknown> | null;
  if (delegate == null || typeof delegate !== 'object' || Array.isArray(delegate)) return message;
  if (Object.keys(delegate).some((k) => k !== 'username' && k !== 'hostSlug')) return message;
  if (!isShortString(delegate.username)) return message;
  if (delegate.hostSlug !== undefined && !isShortString(delegate.hostSlug)) return message;
  if (hint.controlledUsername !== username) {
    return 'delegation.controlledUsername must be the username the access was granted on';
  }
  const clean: DelegationHint = {
    isDelegatedAccess: true,
    controlledUsername: hint.controlledUsername,
    delegate: { username: delegate.username }
  };
  if (delegate.hostSlug !== undefined) clean.delegate.hostSlug = delegate.hostSlug as string;
  return clean;
}

/** Default life of a decided request after a poll first reads it. */
const DEFAULT_TERMINAL_RETENTION_MS = 120 * 1000;
/** Default life of a credential hand-off secret, in seconds. Clamped to the
 * request's remaining life and to `sharedSecrets:maxTtl` when created. */
const DEFAULT_HANDOFF_TTL_S = 600;
/** Default ceiling on the access requests one core holds at once.
 *
 * Creating a request needs no credentials and it is held in the core's master
 * process for up to an hour, so without a ceiling a flood of POSTs grows that
 * process until it dies. Two ceilings bound that memory together: this count
 * and `DEFAULT_MAX_REQUEST_BYTES` per request, so 10000 requests are at most
 * ~160 MB and a realistic one is a few hundred KB. Both are the last line: a
 * reverse-proxy rate limit in front of `/reg/access` is what keeps a flood
 * from reaching the core at all. */
const DEFAULT_MAX_LIVE_REQUESTS = 10000;
/** Default ceiling on the stored size of ONE access request, in bytes.
 *
 * The count ceiling alone bounds nothing: the body limit is
 * `uploads:maxSizeMb` (50 MB by default) and `requestedPermissions`,
 * `clientData`, `oauthState` and a consent form are stored as sent, so a few
 * hundred oversized requests would exhaust the master well under the count.
 * A real request with a consent form stays under 4 KB. */
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;

export default function (expressApp: ExpressApp, app: AppLike) {
  // Read per request, so a config change (or a test override) applies.
  // 0 disables the shortening: the state then lives its full request TTL.
  function terminalRetentionMs (): number {
    const value = app.config.get('access:terminalRetentionMs');
    return typeof value === 'number' && value >= 0 ? value : DEFAULT_TERMINAL_RETENTION_MS;
  }

  // Read per request, same reason as terminalRetentionMs. 0 disables the
  // ceiling; a negative value is not a way to ask for anything, so it falls
  // back to the default rather than silently disabling it.
  function maxLiveRequests (): number {
    const value = app.config.get('access:maxLiveRequests');
    return typeof value === 'number' && value >= 0 ? value : DEFAULT_MAX_LIVE_REQUESTS;
  }

  // Read per request, same reason as terminalRetentionMs. 0 disables it.
  function maxRequestBytes (): number {
    const value = app.config.get('access:maxRequestBytes');
    return typeof value === 'number' && value >= 0 ? value : DEFAULT_MAX_REQUEST_BYTES;
  }

  // Read per request, same reason as terminalRetentionMs.
  function handoffTtlSeconds (): number {
    const value = app.config.get('access:handoffTtl');
    return typeof value === 'number' && value > 0 ? value : DEFAULT_HANDOFF_TTL_S;
  }

  /**
   * The ACCEPTED body, shared by the poll (GET) and the accept response
   * (POST). A hand-off state carries a one-time `handoff` key and NO token
   * (the token moved into the secret); an inline state carries the token.
   * `delegation` is a non-secret display hint that rides at the top level in
   * either shape.
   */
  function acceptedBody (state: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {
      status: 'ACCEPTED',
      username: state.username,
      apiEndpoint: state.apiEndpoint
    };
    if (state.handoff != null) body.handoff = state.handoff;
    else body.token = state.token;
    if (state.delegation != null) body.delegation = state.delegation;
    return body;
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

      // Same `!= null` rule as `consent`: an absent option serialised as
      // null is "not sent".
      if (req.body.actAs != null) {
        const message = actAsError(req.body.actAs);
        if (message != null) {
          return res.status(400).json({ error: { id: 'invalid-parameters', message } });
        }
      }

      // Delivery mode. Absent means today's inline delivery. The only value
      // the server understands is 'shared-secret'; anything else fails loud
      // (the authUrl precedent) rather than degrading silently. The 201 echo
      // below is the app's detection signal, same as `consent`.
      let credentialHandoff: 'shared-secret' | undefined;
      if (req.body.credentialHandoff != null) {
        if (req.body.credentialHandoff !== 'shared-secret') {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: "credentialHandoff must be 'shared-secret'" }
          });
        }
        credentialHandoff = 'shared-secret';
      }

      const { key, state, expiresAt } = accessState.buildState({
        ...req.body,
        consent: consentForm,
        actAs: req.body.actAs ?? undefined,
        credentialHandoff
      });

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

      // What gets STORED is what has to be bounded: the fields an app sends
      // (permissions, clientData, oauthState, a consent form) are kept as
      // sent, and the body limit above them is megabytes.
      const byteCeiling = maxRequestBytes();
      if (byteCeiling > 0) {
        const size = Buffer.byteLength(JSON.stringify(state), 'utf8');
        if (size > byteCeiling) {
          return res.status(413).json({
            error: {
              id: ErrorIds.PayloadTooLarge,
              message: 'This access request is too large to be held by the core.'
            }
          });
        }
      }

      // Persist the fully-built state once — buildState only prepared the
      // shape; we write it here, after the URLs are computed. The write
      // carries the ceiling on how many requests this core holds, so the
      // count and the write cannot be raced apart: an unauthenticated caller
      // must not be able to fill the core's memory with pending requests.
      const stored = await accessState.persistNew(key, state, expiresAt, maxLiveRequests());
      if (!stored) {
        // Says neither the ceiling nor how close the caller got. The drain
        // rate is unknown (requests leave as users decide them, or on
        // expiry), so Retry-After is a flat, honest minute.
        res.set('Retry-After', '60');
        return res.status(429).json({
          error: {
            id: ErrorIds.TooManyRequests,
            message: 'Too many access requests are pending on this core. Please retry later.'
          }
        });
      }

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
      // Echoed only when the server understood the delivery mode; an older
      // core drops the field and echoes nothing, which is how a new client
      // learns it will get inline delivery instead.
      if (state.credentialHandoff !== undefined) created.credentialHandoff = state.credentialHandoff;
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
        // Access-creation parameters the app asked for, which the auth page
        // passes to accesses.create (and app-web-auth3 displays). Absent
        // when the app did not send them.
        if (state.deviceName != null) response.deviceName = state.deviceName;
        if (state.expireAfter != null) response.expireAfter = state.expireAfter;
        if (state.token != null) response.token = state.token;
        // Who the app wants the access for; absent when it did not say.
        if (state.actAs != null) response.actAs = state.actAs;
        // Delivery mode, so the auth UI can decide whether to create the
        // secret itself (shape H) or post the token inline. Absent otherwise.
        if (state.credentialHandoff != null) response.credentialHandoff = state.credentialHandoff;
      } else if (state.status === 'ACCEPTED') {
        // Either a one-time `handoff` key (no token here) or the inline
        // token; `delegation` rides at the top level in either shape.
        // `accessInfo().delegation` on the token is the authoritative answer.
        Object.assign(response, acceptedBody(state));
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

      // Load the pending request once: the accept shape rules depend on
      // whether it asked for a credential hand-off and whether it carried a
      // consent form.
      const pending = await accessState.get(req.params.key);
      if (!pending) {
        return res.status(400).json({
          error: { id: 'unknown-access-key', message: 'Unknown or expired access key' }
        });
      }

      const hasHandoffField = req.body.handoff != null;
      const hasToken = typeof req.body.token === 'string' && req.body.token !== '';
      const wantsHandoff = pending.credentialHandoff === 'shared-secret';
      const isDelegatedGrant = req.body.delegation != null;

      // A hand-off describes an accepted grant only (like the delegation hint).
      // Refuse it on any other status BEFORE anything is written: `handoff` is
      // an updatable field, so a REFUSED/ERROR/REDIRECTED post carrying one
      // would otherwise store an unvalidated object, and a later legitimate
      // inline ACCEPTED would then drop the real token (the state store clears
      // the token whenever a handoff is present) and serve the poisoned body.
      if (hasHandoffField && status !== 'ACCEPTED') {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'handoff is only valid with status ACCEPTED' }
        });
      }

      if (status === 'ACCEPTED') {
        // username is always required (both shapes): it looks up the access,
        // and a non-string would fault deep in the loader rather than being
        // reported as the malformed request it is.
        if (typeof req.body.username !== 'string' || req.body.username === '') {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: 'ACCEPTED requires a username' }
          });
        }
        // Exactly one credential shape: the inline token, or a hand-off key,
        // never both and never neither. "Both" is what would let a
        // half-migrated UI leak a token beside a hand-off; check the token by
        // presence (not just a valid string) so a non-string token cannot ride
        // alongside a hand-off unnoticed.
        if (hasHandoffField && req.body.token != null) {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: 'ACCEPTED must carry either token (inline) or handoff, not both' }
          });
        }
        if (!hasHandoffField && !hasToken) {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: 'ACCEPTED requires a token or a handoff' }
          });
        }
        // A UI-created hand-off (shape H) is accepted only when the request
        // asked for it, is NOT a consent-form request (the grant check needs
        // the token, so those post inline and the server converts), and is NOT
        // a delegated grant (a delegation-derived token may not create the
        // secret, so those deliver inline). Each refusal leaves the request
        // NEED_SIGNIN so the page can post again.
        if (hasHandoffField) {
          if (!wantsHandoff) {
            return res.status(400).json({
              error: { id: 'invalid-parameters', message: 'handoff is only valid when the request set credentialHandoff' }
            });
          }
          if (pending.consent != null) {
            return res.status(400).json({
              error: { id: 'invalid-parameters', message: 'a consent-form request cannot use a UI-created handoff; post the token inline' }
            });
          }
          if (isDelegatedGrant) {
            return res.status(400).json({
              error: { id: 'invalid-parameters', message: 'a delegated grant cannot use a UI-created handoff; post the token inline' }
            });
          }
        }
      }

      // The `delegation` hint only describes an accepted grant. Validated
      // before anything is written, so a bad post leaves the request
      // pending and the page can post again.
      let update: Record<string, unknown> = req.body;
      if (req.body.delegation != null) {
        if (status !== 'ACCEPTED') {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: 'delegation is only valid with status ACCEPTED' }
          });
        }
        const hint = parseDelegationHint(req.body.delegation, req.body.username);
        if (typeof hint === 'string') {
          return res.status(400).json({ error: { id: 'invalid-parameters', message: hint } });
        }
        update = { ...req.body, delegation: hint };
      } else if (req.body.delegation === null) {
        update = { ...req.body, delegation: undefined };
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
      // opaque-token contract for every other integrator UI. A consent-form
      // request always posts the token inline (shape H is refused above), so
      // the token is present here.
      if (status === 'ACCEPTED' && pending.consent != null) {
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

      // Decide how the credential is delivered, after the consent check (so a
      // bad grant is refused before any secret exists).
      if (status === 'ACCEPTED' && hasHandoffField) {
        // Shape H: the auth UI created the secret itself and posts only the
        // key. Store it verbatim; the token never reaches this core.
        const parsed = parseHandoffField(req.body.handoff, sharedSecrets.key.parse);
        if (typeof parsed === 'string') {
          return res.status(400).json({ error: { id: 'invalid-parameters', message: parsed } });
        }
        const apiErr = tokenlessEndpointError(req.body.apiEndpoint);
        if (apiErr != null) {
          return res.status(400).json({ error: { id: 'invalid-parameters', message: apiErr } });
        }
        update = { status: 'ACCEPTED', username: req.body.username, apiEndpoint: req.body.apiEndpoint, handoff: parsed };
      } else if (status === 'ACCEPTED' && wantsHandoff && !isDelegatedGrant) {
        // Shape L on a request that asked for a hand-off, not delegated:
        // server conversion. Move the inline token into a one-time secret on
        // the user's core and keep only the key. The token exists on this
        // core for the life of this handler only, never stored.
        // Clamp to the request's remaining life AND to sharedSecrets:maxTtl:
        // that cap is a hard REFUSAL in the create, not a silent clamp, so a
        // handoffTtl above it would make every conversion fail (permanent
        // inline fallback) instead of just shortening the secret.
        const maxTtlCfg = app.config.get('sharedSecrets:maxTtl');
        const maxTtlS = typeof maxTtlCfg === 'number' && maxTtlCfg > 0 ? maxTtlCfg : 2592000;
        const remainingS = Math.floor((pending.expiresAt - Date.now()) / 1000);
        const ttlSeconds = Math.max(1, Math.min(handoffTtlSeconds(), remainingS, maxTtlS));
        const result = await createHandoff({
          app,
          username: req.body.username,
          token: req.body.token,
          apiEndpoint: req.body.apiEndpoint,
          requestingAppId: pending.requestingAppId,
          ttlSeconds
        });
        if ('handoff' in result) {
          update = { status: 'ACCEPTED', username: req.body.username, apiEndpoint: result.apiEndpoint, handoff: result.handoff };
        } else {
          // Fall back to inline delivery: never worse than today. Log the
          // reason class and the request key, never the token.
          logger.warn('credential hand-off fell back to inline for access request ' +
            req.params.key + ' (' + result.fallback + ')');
        }
      }

      const state = await accessState.update(req.params.key, update);
      if (!state) {
        return res.status(400).json({
          error: { id: 'unknown-access-key', message: 'Unknown or expired access key' }
        });
      }

      let response: Record<string, unknown>;
      if (state.status === 'ACCEPTED') {
        response = acceptedBody(state);
      } else {
        response = { status: state.status };
        if (state.status === 'REFUSED' || state.status === 'ERROR') {
          response.reasonId = state.reasonId;
          response.message = state.message;
        } else if (state.status === 'REDIRECTED') {
          response.poll = state.redirectUrl;
          response.redirectUrl = state.redirectUrl;
        }
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
