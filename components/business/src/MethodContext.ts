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
