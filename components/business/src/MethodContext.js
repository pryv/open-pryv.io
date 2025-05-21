/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const bluebird = require('bluebird');
const timestamp = require('unix-timestamp');
const AccessLogic = require('./accesses/AccessLogic');
const APIError = require('errors').APIError;
const errors = require('errors').factory;
const { getUsersRepository } = require('business/src/users');
const { getMall } = require('mall');
const cache = require('cache');
const { DummyTracing } = require('tracing');
const AUTH_SEPARATOR = ' ';
const ACCESS_TYPE_PERSONAL = 'personal';

class MethodContext {
  source;
  user;
  access;
  streams;
  accessToken;
  callerId;
  /**
   * Used in custom auth function
   */
  headers;
  /**
   * API method id, e.g. "events.get"
   */
  methodId;
  originalQuery;
  /**
   * Custom auth function, if one was configured.
   */
  customAuthStepFn;
  mall;
  _tracing;
  /**
   * Used in events.get
   */
  acceptStreamsQueryNonStringified;
  /**
   * Whether to disable or not some backward compatibility setting, originally for system stream id prefixes
   */
  disableBackwardCompatibility;

  constructor (source, username, auth, customAuthStepFn, headers, query, tracing) {
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
    if (headers != null) {
      this.disableBackwardCompatibility =
                headers['disable-backward-compatibility-prefix'] || false;
    }
    this._tracing = tracing;
  }

  get tracing () {
    if (this._tracing == null) {
      console.log('XXXXXXX >>>>>> Null tracer', new Error());
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
   * @param {string} auth
   * @returns {void}
   */
  parseAuth (auth) {
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
   * @returns {Promise<void>}
   */
  async init () {
    this.mall = await getMall();
    const usersRepository = await getUsersRepository();
    this.user = {
      id: await usersRepository.getUserIdForUsername(this.user.username),
      username: this.user.username
    };
    if (!this.user.id) { throw errors.unknownResource('user', this.user.username); }
  }

  /**
   * Retrieve the userBusiness
   * @returns {Promise<any>}
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
   * @param {StorageLayer} storage
   * @returns {Promise<void>}
   */
  async retrieveExpandedAccess (storage) {
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
   * @param {StorageLayer} storage
   * @returns {Promise<void>}
   */
  async _retrieveAccess (storage, query) {
    const access = await bluebird.fromCallback((cb) => storage.accesses.findOne(this.user, query, null, cb));
    if (access == null) { throw errors.invalidAccessToken('Cannot find access from token.', 403); }
    this.access = new AccessLogic(this.user.id, access);
    cache.setAccessLogic(this.user.id, this.access);
  }

  /**
   * Internal: Loads `this.access`.
   * @param {StorageLayer} storage
   * @returns {Promise<void>}
   */
  async retrieveAccessFromToken (storage) {
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
   * @param {Access} access
   * @returns {void}
   */
  checkAccessValid (access) {
    const now = timestamp.now();
    if (access.expires != null && now > access.expires) { throw errors.forbidden('Access has expired.'); }
  }

  /**
   * Loads an access by id or throw an error. On success, assigns to
   * `this.access` and `this.accessToken`.
   * @param {StorageLayer} storage
   * @param {string} accessId
   * @returns {Promise<any>}
   */
  async retrieveAccessFromId (storage, accessId) {
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
   * @param {StorageLayer} storage
   * @returns {Promise<void>}
   */
  async checkSessionValid (storage) {
    const access = this.access;
    if (access == null) { throw new Error('AF: access != null'); }
    // Only 'personal' tokens expire - if it is not personal, abort.
    if (access.type !== ACCESS_TYPE_PERSONAL) { return; }
    // assert: type === 'personal'
    const token = access.token;
    const session = await bluebird.fromCallback((cb) => storage.sessions.get(token, cb));
    if (session == null) { throw errors.invalidAccessToken('Access session has expired.', 403); }
    // Keep the session alive (don't await, see below)
    // TODO Maybe delay/amortize this so that we don't write on every request?
    storage.sessions.touch(token, () => null);
  }

  /**
   * Perform custom auth step `customAuthStep`. Errors are caught and rethrown.
   * @param {CustomAuthFunction} customAuthStep
   * @returns {Promise<void>}
   */
  performCustomAuthStep (customAuthStep) {
    return new Promise((resolve, reject) => {
      try {
        customAuthStep(this, (err) => {
          if (err != null) { reject(errors.invalidAccessToken(`Custom auth step failed: ${err.message}`)); }
          resolve();
        });
      } catch (err) {
        // If the custom auth step throws a synchronous exception, then we dont
        // simply log an auth failure, but rather a server failure:
        reject(errors.unexpectedError(`Custom auth step threw synchronously: ${err.message}`));
      }
    });
  }

  /**
   * Get a Stream for StreamId
   * @param {string} streamId  undefined
   * @param {string} storeId  - If storeId is null streamId should be fully scoped
   * @returns {Promise<any>}
   */
  async streamForStreamId (streamId, storeId) {
    return await this.mall.streams.getOneWithNoChildren(this.user.id, streamId, storeId);
  }

  /**
   * @param {any} item
   * @param {string | null} authorOverride
   * @returns {any}
   */
  initTrackingProperties (item, authorOverride) {
    item.created = timestamp.now();
    item.createdBy = authorOverride || this.getTrackingAuthorId();
    return this.updateTrackingProperties(item, authorOverride);
  }

  /**
   * @param {any} updatedData
   * @param {string | null} authorOverride
   * @returns {any}
   */
  updateTrackingProperties (updatedData, authorOverride) {
    updatedData.modified = timestamp.now();
    updatedData.modifiedBy = authorOverride || this.getTrackingAuthorId();
    return updatedData;
  }

  /**
   * Returns the authorId, formed by the access id and the callerId.
   * @returns {string}
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
module.exports = MethodContext;

/** @typedef {(err: any) => void} CustomAuthFunctionCallback */

/**
 * @typedef {(
 *   b: MethodContext,
 *   a: CustomAuthFunctionCallback
 * ) => void} CustomAuthFunction
 */

/** @typedef {'http' | 'socket.io' | 'hf' | 'test'} ContextSourceName */

/**
 * @typedef {{
 *   name: ContextSourceName;
 *   ip?: string;
 * }} ContextSource
 */

/**
 * @typedef {{
 *   id: string | undefined | null;
 *   username: string;
 * }} UserDef
 */

/**
 * @typedef {{
 *   accessToken: string;
 *   callerId?: string;
 * }} AuthenticationData
 */
