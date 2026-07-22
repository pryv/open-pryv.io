/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { HttpHeaders } from './types/public.ts';
import type { Mall } from 'mall/src/types.ts';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const timestamp = require('unix-timestamp');
const AccessLogic = require('./accesses/AccessLogic.ts').default;
const APIError = require('errors').APIError;
const errors = require('errors').factory;
const { getUsersRepository } = require('business/src/users/index.ts');
const { getMall } = require('mall');
const cache = require('cache').default;
const { DummyTracing } = require('tracing');
const AUTH_SEPARATOR = ' ';
const ACCESS_TYPE_PERSONAL = 'personal';

class MethodContext {
  source: ContextSource;
  user: UserDef;
  // Populated lazily by retrieveAccess*; consumers must guard against null.
  access: InstanceType<typeof AccessLogic> | null;
  // Legacy field, not actively used today; kept for compatibility.
  streams: unknown;
  accessToken: string | null;
  callerId: string | null;
  /**
   * Used in custom auth function
   */
  headers: HttpHeaders;
  /**
   * API method id, e.g. "events.get"
   */
  methodId: string | null;
  originalQuery: Record<string, unknown> | undefined;
  /**
   * Custom auth function, if one was configured.
   */
  customAuthStepFn: CustomAuthFunction | null;
  mall: Mall | null;
  /** Audit payload landed by api-server create steps (events/accesses) and
   *  consumed by the audit component when recording the call. */
  auditIntegrityPayload?: { key: string; integrity: string };
  /** Raw Authorization header value, landed by the auth.delete route and
   *  checked against auth.adminAccessKey by the deletion chain. */
  authorizationHeader?: string;
  _tracing: unknown;
  /**
   * Used in events.get
   */
  acceptStreamsQueryNonStringified: boolean | undefined;

  /**
   * Authorization scheme the caller used, when one was recognized.
   * 'dpop' ⇒ the token came as `Authorization: DPoP <token>`; null for
   * Bearer/bare/query auth (getAuth strips Bearer upstream on the http
   * path). Drives the sender-constrained-token checks.
   */
  authScheme: 'dpop' | null;
  /**
   * The client-facing request line a DPoP proof must cover — set by the
   * http transports (initContext). Transports that cannot carry a
   * per-request proof (socket.io, hfs) leave it null, so a DPoP-bound
   * access FAILS CLOSED there by construction.
   */
  requestSignatureTarget: { htm: string; htu: string } | null;
  /**
   * Set true once the request authenticated via a valid file
   * `readToken` (HMAC over fileId + access.token). That HMAC is itself a
   * server-issued possession proof for a single-file attachment read, so
   * it substitutes for a DPoP proof on the attachment-download path —
   * a `<img src>` / drag-drop / download GET cannot carry a DPoP header.
   * Scoped to that capability only; never set for a general API call.
   */
  readTokenAuthenticated: boolean;

  constructor (source: ContextSource, username: string, auth: string | null, customAuthStepFn: CustomAuthFunction | null, headers: HttpHeaders, query: Record<string, unknown>, tracing: unknown) {
    this.source = source;
    this.user = { id: null, username };
    this.mall = null;
    this.access = null;
    this.customAuthStepFn = customAuthStepFn;
    this.accessToken = null;
    this.callerId = null;
    this.headers = headers;
    this.methodId = null;
    this.authScheme = null;
    this.requestSignatureTarget = null;
    this.readTokenAuthenticated = false;
    if (auth != null) { this.parseAuth(auth); }
    this.originalQuery = structuredClone(query);
    if (this.originalQuery?.auth) { delete this.originalQuery.auth; }
    this._tracing = tracing;
  }

  get tracing () {
    if (this._tracing == null) {
      this._tracing = new DummyTracing();
    }
    return this._tracing;
  }

  set tracing (tracing) {
    this._tracing = tracing;
  }

  /**
   * Extracts access token and optional caller id from the given auth string,
   * assigning to `this.accessToken` and `this.callerId`.
   */
  parseAuth (auth: string) {
    // RFC 9449 scheme: `DPoP <token>`. Recognized here (not in getAuth)
    // so every transport that hands the raw header to a MethodContext —
    // including the batch route, which skips getAuth — sees the scheme.
    // Auth-scheme names compare case-insensitively (RFC 9110 §11.1).
    if (/^dpop /i.test(auth)) {
      this.authScheme = 'dpop';
      auth = auth.substring(5).trim();
    }
    this.accessToken = auth;
    // Sometimes, the auth string will look like this:
    //    'TOKEN CALLERID'
    // (where the ' ' in the middle is AUTH_SEPARATOR)
    const sepIndex = auth.indexOf(AUTH_SEPARATOR);
    if (sepIndex > 0) {
      // found, not at the start
      this.accessToken = auth.substring(0, sepIndex);
      this.callerId = auth.substring(sepIndex + 1);
    }
  }

  /**
   * Load the userId and mall
   */
  async init () {
    this.mall = await getMall();
    const usersRepository = await getUsersRepository();
    // Resolve the addressed name (primary username OR a routable alias) to the
    // userId, then pin `username` to the CANONICAL primary username — never the
    // alias. Keeps username-keyed concerns (pubsub, cache, apiEndpoint for
    // non-aliased accesses) correct when a request is addressed by alias.
    const addressedName = this.user.username;
    const userId = await usersRepository.getUserIdForUsername(addressedName);
    if (!userId) { throw errors.unknownResource('user', addressedName); }
    const canonicalUsername = await usersRepository.getUsernameForUserId(userId);
    this.user = {
      id: userId,
      username: canonicalUsername ?? addressedName
    };
  }

  /**
   * Retrieve the userBusiness
   */
  async retrieveUser () {
    this.mall = await getMall();
    try {
      // get user details
      const usersRepository = await getUsersRepository();
      const user = await usersRepository.getUserByUsername(this.user.username);
      if (!user) { throw errors.unknownResource('user', this.user.username); }
      return user;
    } catch (err) {
      throw errors.unknownResource('user', this.user.username);
    }
  }

  /**
   * Retrieves the context's access from its token (auth in constructor)
   *
   * If the context's access is already set, the initial step is skipped. This
   * allows callers to implement custom retrieval logic if needed (e.g. using a
   * read token for attached files).
   *
   * This function throws/rejects for various reasons; but it will always throw
   * a subclass of APIError.
   *
   */
  async retrieveExpandedAccess (storage: StorageLike) { // storage layer; not modelled
    try {
      if (this.access == null) { await this.retrieveAccessFromToken(storage); }
      const access = this.access;
      if (access == null) { throw new Error('AF: this.access != null'); }
      // Operator-revoked DPoP keys: reject any access bound to a revoked key
      // thumbprint (jkt), cluster-wide within the cache TTL. Runs BEFORE the
      // proof check so a revoked key pays no ES256 verify and writes no jti
      // replay rows. Same shared choke point as the binding check, so it
      // covers every transport.
      await this.checkDpopKeyNotRevoked();
      // Sender-constrained (DPoP) accesses: enforce proof-of-possession
      // for EVERY expansion, whatever the transport. Must run at this
      // shared choke point — moving it to an http-only path would let a
      // bound token be replayed over socket.io/hfs.
      await this.checkDpopBinding();
      // Check if the session is valid; touch it.
      await this.checkSessionValid(storage);
      // Perform the custom auth step.
      const customAuthStep = this.customAuthStepFn;
      if (customAuthStep != null) { await this.performCustomAuthStep(customAuthStep); }
      // those 2 last are executed in callbatch for each call.
      // Load the streams we can access.
      if (!access.isPersonal()) { await access.loadPermissions(); }
    } catch (err) {
      if (err != null && !(err instanceof APIError)) {
        throw errors.unexpectedError(err);
      }
      // assert: err instanceof APIError
      throw err;
    }
  }

  /**
   * Generic retrieve access
   */
  async _retrieveAccess (storage: StorageLike, query: Record<string, unknown>) {
    const access = await fromCallback((cb: NodeCallback) => storage.accesses.findOne(this.user, query, null, cb));
    if (access == null) { throw errors.invalidAccessToken('Cannot find access from token.', 403); }
    this.access = new AccessLogic(this.user.id, access);
    cache.setAccessLogic(this.user.id, this.access);
  }

  /**
   * Internal: Loads `this.access`.
   */
  async retrieveAccessFromToken (storage: StorageLike) { // storage layer
    const token = this.accessToken;
    if (token == null) {
      throw errors.invalidAccessToken('The access token is missing: expected an ' +
                '"Authorization" header or an "auth" query string parameter.');
    }
    this.access = cache.getAccessLogicForToken(this.user.id, token);
    if (this.access == null) {
      // retreiveing from Db
      await this._retrieveAccess(storage, { token });
    }
    this.checkAccessValid(this.access);
  }

  /**
   * Performs validity checks on the given access. You must call this after
   * every access load that needs to return a valid access. Internal function,
   * since all the 'retrieveAccessFromToken*' methods call it.
   *
   * Returns nothing but throws if an error is detected.
   *
   */
  checkAccessValid (access: { type?: string; expires?: number | null; deleted?: unknown } | null) {
    if (access == null) return;
    const now = timestamp.now();
    if (access.expires != null && now > access.expires) { throw errors.forbidden('Access has expired.'); }
  }

  /**
   * Enforce DPoP (RFC 9449) sender constraint. An access carrying a
   * `clientData.dpop.jkt` binding is only usable with a valid DPoP
   * proof signed by the bound key, covering THIS request (htm/htu) and
   * THIS token (ath), with a single-use jti. An unbound access
   * presented under the `DPoP` scheme is refused too — the token kind
   * is fixed at issuance. Every refusal is the same uniform 403 (no
   * oracle); reasons never leave the server.
   */
  async checkDpopBinding () {
    // A validated file readToken is itself the possession proof for the
    // attachment-download capability (see readTokenAuthenticated) — that
    // GET cannot carry a DPoP header, so the HMAC substitutes.
    if (this.readTokenAuthenticated) return;
    const boundJkt = (this.access as { clientData?: { dpop?: { jkt?: unknown } } } | null)?.clientData?.dpop?.jkt;
    const refused = () => {
      const err = errors.invalidAccessToken('DPoP proof verification failed.', 403);
      // Emitted as a WWW-Authenticate challenge by the http error layer.
      err.httpHeaders = { 'WWW-Authenticate': 'DPoP algs="ES256", error="invalid_token"' };
      return err;
    };
    if (typeof boundJkt !== 'string') {
      if (this.authScheme === 'dpop') throw refused();
      return;
    }
    const proofHeader = (this.headers as Record<string, unknown> | null)?.dpop;
    const target = this.requestSignatureTarget;
    if (proofHeader == null || target == null || this.accessToken == null) throw refused();
    // Lazy requires: only sender-constrained requests pay for these, and
    // business stays load-order-independent from the oauth2 component.
    const { verifyDPoPProof, DPoPProofError } = require('oauth2/src/dpop.ts');
    const { markDPoPJtiUsed } = require('oauth2/src/storage.ts');
    const platform = require('storages').platformDB;
    if (platform == null) throw errors.unexpectedError(new Error('platform storage unavailable for DPoP validation'));
    let clockSkewSeconds = 120;
    try {
      const configured = require('@pryv/boiler').getConfigSync().get('oauth:dpop:clockSkewSeconds');
      if (configured != null) clockSkewSeconds = Number(configured);
    } catch { /* config not booted (unit contexts) — keep the default */ }
    let verified;
    try {
      verified = await verifyDPoPProof(Array.isArray(proofHeader) ? null : proofHeader, {
        htm: target.htm,
        htu: target.htu,
        accessToken: this.accessToken,
        clockSkewSeconds,
      });
    } catch (err) {
      if (err instanceof DPoPProofError) throw refused();
      throw err;
    }
    if (verified.jkt !== boundJkt) throw refused();
    const fresh = await markDPoPJtiUsed(platform, verified.jkt, verified.jti, Date.now() + 2 * clockSkewSeconds * 1000);
    if (!fresh) throw refused();
  }

  /**
   * Reject an access bound to an operator-revoked DPoP key thumbprint — so a
   * `revoke-key <jkt>` reaches live tokens within the cache TTL, instead of
   * waiting out their ~1 h TTL. Presence (blocklist) semantics: any token bound
   * to a tombstoned jkt is dead regardless of when it was minted (a jkt is the
   * key itself, not a re-assignable name — see storage.ts revokeDpopKey).
   *
   * Unlike checkDpopBinding, this does NOT skip `readTokenAuthenticated`: the
   * revoke needs no proof, so an attachment-download GET minted under a
   * revoked-key session is refused too (only the key's OWN downloads — a
   * non-revoked key's readToken still short-circuits in checkDpopBinding).
   *
   * Fail-open when the platform store is unavailable (e.g. unit contexts): the
   * revoke is a bounded-SLA control, not an availability gate.
   */
  async checkDpopKeyNotRevoked () {
    const boundJkt = (this.access as { clientData?: { dpop?: { jkt?: unknown } } } | null)?.clientData?.dpop?.jkt;
    if (typeof boundJkt !== 'string') return;
    const platform = require('storages').platformDB;
    if (platform == null) return;
    // Clamp the configured TTL: a non-numeric value would make the cache's
    // `now - loadedAt > NaN` always false (never refresh → revoke never takes
    // effect); a non-positive value would refresh on every request.
    let ttlSeconds = 30;
    try {
      const configured = Number(require('@pryv/boiler').getConfigSync().get('oauth:dpop:keyRevokeCheckSeconds'));
      if (Number.isFinite(configured) && configured > 0) ttlSeconds = configured;
    } catch { /* config not booted (unit contexts) — keep the default */ }
    const { isKeyRevoked } = require('oauth2/src/revokedKeysCache.ts');
    if (await isKeyRevoked(platform, boundJkt, ttlSeconds)) {
      throw errors.invalidAccessToken('The application access has been revoked.', 403);
    }
  }

  /**
   * Loads an access by id or throw an error. On success, assigns to
   * `this.access` and `this.accessToken`.
   */
  async retrieveAccessFromId (storage: StorageLike, accessId: string) {
    this.access = cache.getAccessLogicForId(this.user.id, accessId);
    if (this.access == null) {
      await this._retrieveAccess(storage, { id: accessId });
    }
    this.accessToken = this.access.token;
    this.checkAccessValid(this.access);
    return this.access;
  }

  /**
   * Loads session and touches it (personal sessions only)
   */
  async checkSessionValid (storage: StorageLike) { // storage layer
    const access = this.access;
    if (access == null) { throw new Error('AF: access != null'); }
    // Only 'personal' tokens expire - if it is not personal, abort.
    if (access.type !== ACCESS_TYPE_PERSONAL) { return; }
    // assert: type === 'personal'
    const token = access.token;
    const session = await fromCallback((cb: NodeCallback) => storage.sessions.get(token, cb));
    if (session == null) { throw errors.invalidAccessToken('Access session has expired.', 403); }
    // Keep the session alive (don't await, see below)
    storage.sessions.touch(token, () => null);
  }

  /**
   * Perform custom auth step `customAuthStep`. Errors are caught and rethrown.
   */
  performCustomAuthStep (customAuthStep: CustomAuthFunction) {
    return new Promise<void>((resolve, reject) => {
      try {
        customAuthStep(this, (err: Error | null | undefined) => {
          if (err != null) { reject(errors.invalidAccessToken(`Custom auth step failed: ${err.message}`)); }
          resolve();
        });
      } catch (err) {
        // If the custom auth step throws a synchronous exception, then we dont
        // simply log an auth failure, but rather a server failure:
        const msg = err instanceof Error ? err.message : String(err);
        reject(errors.unexpectedError(`Custom auth step threw synchronously: ${msg}`));
      }
    });
  }

  /**
   * Get a Stream for StreamId
   * @param streamId  undefined
   * @param storeId  - If storeId is null streamId should be fully scoped
   */
  async streamForStreamId (streamId: string, storeId: string | null) {
    return await this.mall!.streams.getOneWithNoChildren(this.user.id as string, streamId, storeId);
  }

  initTrackingProperties (item: { created?: number; createdBy?: string; modified?: number; modifiedBy?: string; [k: string]: unknown }, authorOverride?: string | null) {
    item.created = timestamp.now();
    item.createdBy = authorOverride || this.getTrackingAuthorId();
    return this.updateTrackingProperties(item, authorOverride);
  }

  updateTrackingProperties (updatedData: { modified?: number; modifiedBy?: string; [k: string]: unknown }, authorOverride?: string | null) {
    updatedData.modified = timestamp.now();
    updatedData.modifiedBy = authorOverride || this.getTrackingAuthorId();
    return updatedData;
  }

  /**
   * Returns the authorId, formed by the access id and the callerId.
   */
  getTrackingAuthorId () {
    const access = this.access;
    if (access == null) { throw new Error('Access needs to be retrieved first.'); }
    let authorId = access.id;
    if (this.callerId != null) {
      authorId += AUTH_SEPARATOR + this.callerId;
    }
    return authorId;
  }
}
export default MethodContext;
export { MethodContext };
export type { CustomAuthFunction, CustomAuthFunctionCallback, StorageLike };
type CustomAuthFunctionCallback = (err: Error | null | undefined) => void;
type CustomAuthFunction = (ctx: MethodContext, cb: CustomAuthFunctionCallback) => void;
type NodeCallback<T = unknown> = (err: unknown, value?: T) => void;

type ContextSourceName = 'http' | 'socket.io' | 'hf' | 'test';
type ContextSource = {
  name: ContextSourceName;
  ip?: string;
};
type UserDef = {
  id: string | undefined | null;
  username: string;
};
type StorageLike = {
  accesses: { findOne: (user: UserDef, query: Record<string, unknown>, opts: unknown, cb: NodeCallback) => void };
  sessions: { get: (token: string, cb: NodeCallback) => void; touch: (token: string, cb: NodeCallback) => void };
};
type AuthenticationData = {
  accessToken: string;
  callerId?: string;
};
