/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `POST /oauth2/authorize/accept` handler.
 *
 * Called from the consent UI after the user accepts. Body:
 *   { state: <signed-state>, username: <user>, userToken: <user's
 *     personal access token>,
 *     grantedPermissions: Permission[] }   — the kept subset of the
 *     signed offer's granular permission set (full accesses.create
 *     lexicon: stream AND feature permissions).
 *
 * Server flow:
 *   1. Verify the signed state (400 on tamper/expired).
 *   2. Validate grantedPermissions ⊆ the signed offer's permissions
 *      (consent downgrade; exact-entry identity).
 *   3. Resolve {username, userToken} → an authenticated user-session
 *      handle via the injected `resolveUser` helper. The handle carries
 *      whatever the host app needs to make subsequent API calls on
 *      behalf of the user (a MethodContext in the real wiring).
 *   4. Use the injected `createAccess` helper to mint an app access
 *      under that user. The user is the auth principal — full
 *      accesses.create chain runs (permission checks + hooks).
 *   5. Persist the code row in PlatformDB, keyed by the code's SHA-256:
 *      {accessId, coreId, userId, …}, never the access token nor the
 *      username (PlatformDB is replicated to every core). At /token time,
 *      after PKCE verification, this same core reads the access back from
 *      its own storage; the user is gone by then, so all access creation
 *      MUST happen here.
 *   6. Return the redirect URL `redirect_uri?code=…&state=…&iss=…`.
 *
 * Registry clients: the consent screen composes the user's current grant
 * with the request (see consentComposition.ts). The body may carry
 * `shownDigest` (the digest of that composed screen, from the signed-in
 * /oauth2/authorize/offer) and `acknowledgeSubjectChange`. With
 * `shownDigest`, the grant becomes exactly what was ticked (plus its kept
 * restrictions and the client's default forbids); without it, the consent
 * is joined into the grant. A stale `shownDigest`, or a change of subject
 * mode without both `shownDigest` and the acknowledgement, answers 400
 * `invalid_request` with a machine-readable `reason`
 * (`consent-out-of-date`, `subject-change-unacknowledged`).
 *
 * Refuse path: when the user declines, the consent UI does NOT call
 * this endpoint — it calls `POST /oauth2/authorize/refuse` (see
 * refuse.ts), which verifies the signed state and returns the
 * `redirect_uri?error=access_denied&state=…&iss=…` URL to navigate to.
 */

import { createRequire } from 'node:module';

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { ResolvedScope } from '../scopeGrammar.ts';
import type { OAuthClient } from '../storage.ts';
import type { CurrentGrant, Composition, SubjectChange } from '../consentComposition.ts';
const require = createRequire(import.meta.url);

const { resolveStateOffer } = require('./offer.ts');
const { composeShownOffer, nextGrantPermissions } = require('../consentComposition.ts');
const { getClient } = require('../clientRegistry.ts');

const { generateToken } = require('../secureToken.ts');
const { verifyState } = require('../signedState.ts');
const { issuerFromConfig } = require('../issuer.ts');
const { setCode } = require('../storage.ts');
const { indexSession } = require('../sessionIndex.ts');
const { audit } = require('../audit.ts');
const { logServerError, logServerWarning } = require('../serverLog.ts');
// Permission-lexicon single point — the consent-grant rule (subset +
// all-or-nothing default + mandatory locks) is shared with the cmc
// accept path.
const { checkConsentGrant, normalizePermissions } =
  require('business/src/accesses/permissionSet.ts');
const { canonicalStreamId } = require('mall/src/helpers/storeDataUtils.ts');

/** Authenticated user-session handle, opaque to this module. */
export type UserSession = {
  userId: string;
  username: string;
  /** Host-app data piggybacked through createAccess (e.g. MethodContext). */
  [key: string]: unknown;
};

/** The token is valid but may not grant OAuth access; `description` says why. */
export type RefusedSession = { refused: true; description: string };

/** Resolver provided by the route mount: {username, userToken} → session, refusal, or null. */
export type ResolveUser = (params: { username: string; userToken: string })
=> Promise<UserSession | RefusedSession | null>;

function isRefusedSession (session: UserSession | RefusedSession): session is RefusedSession {
  return session.refused === true;
}

function isRefusal (v: UserSession | Refusal): v is Refusal {
  return typeof (v as Refusal).status === 'number' && (v as Refusal).body != null;
}

/** Access-creator provided by the route mount: mints an OAuth app access for the resolved user. */
export type CreateAccess = (params: {
  session: UserSession;
  clientId: string;
  scope: string[];
  expiresAt: number;
  /**
   * Granular (cmc-offer) grants only: the signed offer material + the
   * user's granted subset (already validated ⊆ offer). The mount
   * ensures the durable CMC data-grant exists (drives
   * `consent/accept-cmc`, or reuses/widens an existing grant on
   * re-authorization) and mints the short-TTL access from the
   * data-grant's current permissions.
   */
  offer?: {
    offerName: string;
    capabilityUrl: string;
    capabilityId: string | null;
    offerEventId: string | null;
    permissions: Array<Record<string, unknown>>;
  } | {
    /** Registry client: offer synthesised by the extension's grammar, no CMC. */
    kind: 'synthesised';
    permissions: Array<Record<string, unknown>>;
    /**
     * The app asked for a pseudonym (the grant's alias as subject). Always
     * false while pseudonymous subjects are refused at /oauth2/authorize.
     */
    randomAlias?: boolean;
  };
  grantedPermissions?: Array<Record<string, unknown>>;
  /** Registry client: the grant's permissions after this consent (final set). */
  grantPermissions?: Array<Record<string, unknown>>;
  /** Registry client: the acknowledged change of subject mode, if any. */
  subjectChange?: SubjectChange | null;
}) => Promise<{
  accessId: string;
  accessToken: string;
  apiEndpoint: string;
  dataGrantAccessId?: string;
  permissions?: Array<Record<string, unknown>>;
}>;

/**
 * Registry clients: the user's current grant for the client (read only), or
 * null when there is none.
 */
export type ReadRegistryGrant = (params: { session: UserSession; clientId: string }) => Promise<CurrentGrant | null>;

/** Shape of the inputs the host app injects. */
export type AcceptDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  resolveUser: ResolveUser;
  createAccess: CreateAccess;
  /** Absent: a registry client's consent is composed as if no grant existed. */
  readRegistryGrant?: ReadRegistryGrant;
};

type Refusal = { status: number; body: { error: string; error_description: string } };

/** The consent-grant rule's refusal (granted against the offer the screen showed), or null. */
function consentRefusal (
  granted: Array<Record<string, unknown>>,
  offered: { permissions: Array<Record<string, unknown>>; allowUserChoice: boolean }
): Refusal | null {
  let offeredConsent;
  try {
    offeredConsent = normalizePermissions(offered.permissions, { consent: true });
  } catch (e: unknown) {
    // The offer in the signed state was validated at /authorize
    // (resolveOffer rejects e.g. exclusion masks), so reaching here means
    // a stale/forged state. Fail closed with a clean 400, never a 500.
    return {
      status: 400,
      body: { error: 'invalid_scope', error_description: 'consent offer is invalid: ' + ((e as Error)?.message ?? String(e)) },
    };
  }
  // THE consent-grant rule (single point, shared with the cmc accept
  // path): granted ⊆ offered; without the offer's allowUserChoice the
  // grant is ALL OR NOTHING; with it, entries annotated mandatory
  // must still be granted.
  const check = checkConsentGrant(granted, offeredConsent, offered.allowUserChoice);
  if (check.ok) return null;
  const offending = summariseOffending(check.offending);
  const description =
    check.reason === 'choice-not-allowed'
      ? 'this consent is all-or-nothing (the offer does not allow user choice); missing: ' + offending
      : check.reason === 'mandatory-refused'
        ? 'mandatory permissions cannot be unticked; missing: ' + offending
        : 'grantedPermissions must be a subset of the offered permissions; offending: ' + offending;
  return { status: 400, body: { error: 'invalid_scope', error_description: description } };
}

/**
 * A consent asking for a stream at a level that cannot be joined with the
 * level already granted on it (`read` and `create-only`): the only level
 * covering both would grant a capability nobody consented to. A consent
 * error, not a server fault: the description names the stream and both
 * levels, for the consent screen; refused consents are audited.
 */
async function levelConflictRefusal (err: unknown, payload: { clientId: string; scope: string[] }): Promise<Refusal> {
  const description = 'conflicting permission level on a requested resource: ' +
    String((err as Error)?.message ?? '');
  logServerWarning('accept: consent refused, ' + description);
  await audit('oauth.consent.refused', {
    clientId: payload.clientId,
    requestedScope: payload.scope,
    reason: 'permission-level-conflict',
  });
  return { status: 400, body: { error: 'invalid_scope', error_description: description } };
}

/** The consent UI's last screen is not this composition any more. */
export const STALE_SCREEN = 'the consent screen is out of date, restart the authorization flow';
/** A change of subject mode reached /accept without the user's acknowledgement. */
export const SUBJECT_CHANGE_UNACKNOWLEDGED = 'the change of identity mode must be acknowledged';

/** Authorization-code lifetime — 10 minutes per RFC 6749 §4.1.2. */
export const CODE_TTL_SECONDS = 600;

/** Express-style handler factory. */
export function handleAccept (deps: AcceptDeps) {
  return async function accept (req: Request, res: Response): Promise<void> {
    const issuer = issuerFromConfig(deps.config);
    const adminKey = String(deps.config.get('auth:adminAccessKey') ?? '');
    const accessTokenTTL = Number(deps.config.get('oauth:accessTokenTTL') ?? 3600);
    if (!issuer || !adminKey) {
      return sendJson(res, 500, { error: 'server_error', error_description: 'service:api or auth:adminAccessKey not configured' });
    }

    const body = req.body ?? {};
    if (!isNonEmptyString(body.state)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'state is required' });
    }
    if (!isNonEmptyString(body.username)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'username is required' });
    }
    if (!isNonEmptyString(body.userToken)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'userToken is required' });
    }
    const verified = verifyState(adminKey, body.state);
    if (!verified.ok) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: `signed state ${verified.reason}`,
      });
    }
    const payload = verified.payload;
    // A client suspended since /authorize consents to nothing, whatever its
    // kind (no grant, no consent record, no session).
    const stateClient = await getClient(deps.platform, payload.clientId);
    if (stateClient?.status === 'suspended') {
      return sendJson(res, 403, { error: 'access_denied', error_description: 'this client is suspended' });
    }

    // Consent contract (selected by the signed state, never the
    // caller): the granular cmc-offer grant carries
    // `grantedPermissions` — the kept subset of the offer's signed
    // permission set (full lexicon: stream AND feature permissions).
    // A registry client's state carries the offer by reference: re-derive
    // it (digest-checked) instead of reading it from the state.
    let synthesised: ResolvedScope | null = null;
    let registryClient: OAuthClient | null = null;
    if (payload.offer == null && payload.offerRef != null) {
      const r = await resolveStateOffer({ config: deps.config, platform: deps.platform }, payload);
      if (!r.ok) return sendJson(res, r.status, { error: r.error, error_description: r.description });
      synthesised = r.resolved;
      registryClient = r.client;
    } else if (payload.offer == null) {
      // Every authorize-issued state carries the resolved offer; a
      // state without one is stale or foreign.
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'signed state carries no consent offer — restart the authorization flow',
      });
    }
    if (!Array.isArray(body.grantedPermissions)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'grantedPermissions must be an array' });
    }
    // Registry clients: the digest of the composed consent screen the UI
    // showed (absent: a consent UI that does not compose), and the user's
    // acknowledgement of a change of subject mode.
    const shownDigest: string | null = body.shownDigest === undefined || body.shownDigest === null ? null : body.shownDigest;
    if (shownDigest != null && !isNonEmptyString(shownDigest)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'shownDigest must be a non-empty string' });
    }
    if (body.acknowledgeSubjectChange !== undefined && typeof body.acknowledgeSubjectChange !== 'boolean') {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'acknowledgeSubjectChange must be a boolean' });
    }
    let grantedPermissions: Array<Record<string, unknown>>;
    try {
      grantedPermissions = normalizePermissions(body.grantedPermissions);
    } catch (e: unknown) {
      return sendJson(res, 400, {
        error: 'invalid_scope',
        error_description: 'grantedPermissions invalid: ' + ((e as Error)?.message ?? String(e)),
      });
    }
    // A registry consent never creates a stream: display names (which would
    // make the grant's creation add missing streams under the owner's
    // context) are dropped, as they are from the grammar's offer.
    if (synthesised != null) {
      grantedPermissions = grantedPermissions.map((p) => {
        const { defaultName: _d, name: _n, ...rest } = p;
        return rest;
      });
    }
    // One level per stream: the consent check compares entry SETS, so a
    // repeated stream (in any spelling) would pass it and then be refused
    // when the session access is created.
    const duplicateStream = firstDuplicateStream(grantedPermissions);
    if (duplicateStream != null) {
      return sendJson(res, 400, {
        error: 'invalid_scope',
        error_description: `stream "${duplicateStream}" appears more than once in grantedPermissions`,
      });
    }
    if (grantedPermissions.length === 0) {
      return sendJson(res, 400, {
        error: 'invalid_scope',
        error_description: 'grantedPermissions must keep at least one permission (refuse instead)',
      });
    }
    // The cmc:<offer-name> token, echoed as the RFC scope value.
    const granted: string[] = payload.scope;

    const resolveSession = async (): Promise<UserSession | Refusal> => {
      const s = await deps.resolveUser({ username: body.username, userToken: body.userToken });
      if (s == null) {
        return {
          status: 401,
          body: { error: 'invalid_request', error_description: 'username + userToken did not resolve to a valid user session' },
        };
      }
      if (isRefusedSession(s)) return { status: 403, body: { error: 'access_denied', error_description: String(s.description) } };
      return s;
    };

    let session: UserSession;
    // What createAccess checks the granted subset against (tree-aware), and,
    // for a registry client, the grant's final permissions.
    let offeredForMint: Array<Record<string, unknown>>;
    let grantPermissions: Array<Record<string, unknown>> | undefined;
    let subjectChange: SubjectChange | null = null;
    if (synthesised == null) {
      const refused = consentRefusal(grantedPermissions,
        { permissions: payload.offer!.permissions, allowUserChoice: payload.offer!.allowUserChoice === true });
      if (refused != null) return sendJson(res, refused.status, refused.body);
      const s = await resolveSession();
      if (isRefusal(s)) return sendJson(res, s.status, s.body);
      session = s;
      offeredForMint = payload.offer!.permissions;
    } else {
      // A registry client: the screen shows the user's current grant
      // composed with the request, so the user must be known first.
      const s = await resolveSession();
      if (isRefusal(s)) return sendJson(res, s.status, s.body);
      session = s;
      const current: CurrentGrant | null = deps.readRegistryGrant != null
        ? await deps.readRegistryGrant({ session, clientId: payload.clientId })
        : null;
      const composition: Composition = composeShownOffer(synthesised, current, registryClient!);
      if (!composition.ok) {
        const refused = await levelConflictRefusal(composition.error, payload);
        return sendJson(res, refused.status, refused.body);
      }
      if (shownDigest != null && shownDigest !== composition.shownDigest) {
        return sendJson(res, 400, { error: 'invalid_request', error_description: STALE_SCREEN, reason: 'consent-out-of-date' });
      }
      // A consent UI that showed the composition is checked against it; one
      // that did not (no shownDigest) against the request, as it showed it.
      const offered = shownDigest != null
        ? { permissions: composition.shown.permissions, allowUserChoice: composition.shown.allowUserChoice }
        : { permissions: synthesised.offer.permissions, allowUserChoice: synthesised.offer.allowUserChoice === true };
      const refused = consentRefusal(grantedPermissions, offered);
      if (refused != null) return sendJson(res, refused.status, refused.body);
      // A grant reaching no stream grants nothing: refuse instead.
      if (!grantedPermissions.some((p) => typeof p.streamId === 'string')) {
        return sendJson(res, 400, {
          error: 'invalid_scope',
          error_description: 'grantedPermissions must keep at least one stream permission (refuse instead)',
        });
      }
      // Fail closed: a change of subject mode needs a screen that showed it
      // (shownDigest) and the user's explicit acknowledgement.
      if (composition.subjectChange != null &&
          !(shownDigest != null && body.acknowledgeSubjectChange === true)) {
        return sendJson(res, 400, {
          error: 'invalid_request', error_description: SUBJECT_CHANGE_UNACKNOWLEDGED, reason: 'subject-change-unacknowledged',
        });
      }
      subjectChange = composition.subjectChange;
      try {
        grantPermissions = nextGrantPermissions({
          granted: grantedPermissions, current, client: registryClient!, replace: shownDigest != null,
        }) as unknown as Array<Record<string, unknown>>;
      } catch (err: unknown) {
        if ((err as { code?: string } | null)?.code !== 'permission-level-conflict') throw err;
        const r = await levelConflictRefusal(err, payload);
        return sendJson(res, r.status, r.body);
      }
      offeredForMint = normalizePermissions(offered.permissions);
    }

    // Mint the app access under the resolved user. The durable consent
    // record (CMC data-grant, or the registry client's grant) is created or
    // updated first through the API on the user's behalf; the session is
    // then minted from it.
    const accessExpiresAt = Date.now() + accessTokenTTL * 1000;
    let access;
    try {
      access = await deps.createAccess({
        session,
        clientId: payload.clientId,
        scope: granted,
        expiresAt: accessExpiresAt,
        offer: synthesised != null
          ? { kind: 'synthesised', permissions: offeredForMint, randomAlias: synthesised.offer.randomAlias === true }
          : payload.offer!,
        grantedPermissions,
        ...(grantPermissions != null ? { grantPermissions, subjectChange } : {}),
      });
    } catch (err: unknown) {
      // The effective-permission guard (hierarchical consent masking) runs
      // inside createAccess, where the user's stream tree is available. It
      // is a consent-downgrade violation, not a server fault → 400.
      if ((err as { code?: string } | null)?.code === 'consent-widens-offer') {
        return sendJson(res, 400, {
          error: 'invalid_scope',
          error_description: 'grantedPermissions widen the offer under the stream hierarchy — the kept subset must not grant more access than the offer',
        });
      }
      if ((err as { code?: string } | null)?.code === 'permission-level-conflict') {
        const r = await levelConflictRefusal(err, payload);
        return sendJson(res, r.status, r.body);
      }
      // The data holder (peer) refused the consent accept — e.g. the open-link
      // capability already recorded this accepter, or a consumed / invalidated
      // link. Client-correctable, not a server fault → 400 carrying the peer's
      // machine-readable reason so the client can distinguish the cases.
      if ((err as { code?: string } | null)?.code === 'cmc-accept-rejected') {
        const cmcErrorId = (err as { cmcErrorId?: string }).cmcErrorId ?? 'cmc-accept-rejected';
        return sendJson(res, 400, {
          error: 'invalid_grant',
          error_description: 'consent accept rejected: ' + cmcErrorId,
        });
      }
      logServerError('accept: createAccess failed', err);
      return sendJson(res, 500, {
        error: 'server_error',
        error_description: 'failed to create access',
      });
    }

    // One replicated row per session mint: where the token lives (no token,
    // no username in it). Never fails the consent.
    await indexSession(deps.platform, access.accessToken, {
      userId: session.userId,
      accessId: access.accessId,
      clientId: payload.clientId,
      coreId: String(deps.config.get('core:id') ?? 'single'),
      expiresAt: accessExpiresAt,
      ...(access.dataGrantAccessId != null ? { dataGrantAccessId: access.dataGrantAccessId } : {}),
      ...(synthesised != null ? { coreTokens: synthesised.coreTokens, grammarTokens: synthesised.grammarTokens } : {}),
      ...(payload.audience != null ? { audience: payload.audience } : {}),
    });

    // Mint code + persist with the access id so the grant can return the
    // access after PKCE verification (user is gone by then). The token is
    // NOT stored: the platform store is replicated to every core, so the
    // grant reads it back from this core's own storage by id.
    const code = generateToken();
    const codeExpiresAt = Date.now() + CODE_TTL_SECONDS * 1000;
    await setCode(deps.platform, code, {
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: payload.codeChallengeMethod,
      userId: session.userId,
      scope: granted,
      expiresAt: codeExpiresAt,
      accessId: access.accessId,
      coreId: String(deps.config.get('core:id') ?? 'single'),
      ...(access.dataGrantAccessId != null ? { dataGrantAccessId: access.dataGrantAccessId } : {}),
      ...(access.permissions != null ? { permissions: access.permissions } : {}),
      ...(synthesised != null
        ? {
            kind: 'registry',
            coreTokens: synthesised.coreTokens,
            grammarTokens: synthesised.grammarTokens,
          }
        : {}),
      ...(payload.audience != null ? { audience: payload.audience } : {}),
    });

    await audit('oauth.consent.granted', {
      clientId: payload.clientId,
      userId: session.userId,
      requestedScope: payload.scope,
      grantedScope: granted,
      grantedPermissions,
      accessId: access.accessId,
      ...(access.dataGrantAccessId != null ? { dataGrantAccessId: access.dataGrantAccessId } : {}),
      ...(subjectChange != null ? { subjectChange } : {}),
    });

    const sep = payload.redirectUri.indexOf('?') >= 0 ? '&' : '?';
    const redirectTo = payload.redirectUri + sep +
      'code=' + encodeURIComponent(code) +
      '&state=' + encodeURIComponent(payload.state) +
      '&iss=' + encodeURIComponent(issuer);

    return sendJson(res, 200, { redirectTo });
  };
}

/** The first stream named twice (compared by canonical id), or null. */
function firstDuplicateStream (permissions: Array<Record<string, unknown>>): string | null {
  const seen = new Set<string>();
  for (const p of permissions) {
    if (typeof p.streamId !== 'string') continue;
    const id = canonicalStreamId(p.streamId);
    if (seen.has(id)) return p.streamId;
    seen.add(id);
  }
  return null;
}

function isNonEmptyString (v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Bound the offending-permissions list that gets serialised into the
 * client-facing `error_description`, so a client can't force an
 * arbitrarily large error body by submitting a huge grantedPermissions
 * array. Keeps the first few entries for diagnostics and summarises the
 * rest as a count.
 */
const MAX_OFFENDING_IN_ERROR = 20;
function summariseOffending (offending: unknown): string {
  if (!Array.isArray(offending)) return JSON.stringify(offending);
  if (offending.length <= MAX_OFFENDING_IN_ERROR) return JSON.stringify(offending);
  const head = offending.slice(0, MAX_OFFENDING_IN_ERROR);
  return JSON.stringify(head) + ` (+${offending.length - MAX_OFFENDING_IN_ERROR} more)`;
}

function sendJson (res: Response, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
