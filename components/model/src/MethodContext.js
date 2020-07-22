// @flow

const bluebird = require('bluebird');
const timestamp = require('unix-timestamp');
const _ = require('lodash');

import type { Access, User, Stream } from 'components/storage';

const accessLogic = require('./accessLogic');
const APIError = require('components/errors').APIError;
const errors = require('components/errors').factory;
const treeUtils = require('components/utils').treeUtils;

import type { StorageLayer } from 'components/storage';

export type CustomAuthFunctionCallback = (err: any) => void; 
export type CustomAuthFunction = (MethodContext, CustomAuthFunctionCallback) => void; 

export type AuthenticationData = {
  accessToken: string, 
  callerId?: string, 
}

const AUTH_SEPARATOR = ' ';
const ACCESS_TYPE_PERSONAL = 'personal';

class MethodContext {
  // Username of the user making the request. 
  username: string; 
  
  user: ?User;
  access: ?Access; 
  streams: ?Array<Stream>; 
  
  accessToken: ?string; 
  callerId: ?string; 
  
  // Custom auth function, if one was configured. 
  customAuthStepFn: ?CustomAuthFunction;
  
  // will contain the list of "found" streams 
  streamList: ?Array<Stream>;
  // during an event.create action for multiple streams event, some streamIds might not exists. They will be listed here
  streamIdsNotFoundList: ?Array<string>;
  
  calledMethodId: ?string;
  
  constructor(
    username: string, auth: ?string, 
    customAuthStepFn: ?CustomAuthFunction
  ) {
    this.username = username;

    this.user = null;
    this.access = null;
    this.streams = null;

    this.streamList = null;
    this.streamIdsNotFoundList = [];
    this.customAuthStepFn = customAuthStepFn;
    
    this.accessToken = null;
    this.callerId = null; 
    
    this.calledMethodId = null; 
    
    if (auth != null) this.parseAuth(auth);
  }
  
  // Extracts access token and optional caller id from the given auth string, 
  // assigning to `this.accessToken` and `this.callerId`.
  // 
  parseAuth(auth: string) {
    this.accessToken = auth;

    // Sometimes, the auth string will look like this: 
    //    'TOKEN CALLERID'
    // (where the ' ' in the middle is AUTH_SEPARATOR)
    const sepIndex = auth.indexOf(AUTH_SEPARATOR);
    if (sepIndex > 0) { // found, not at the start
      this.accessToken = auth.substring(0, sepIndex);
      this.callerId = auth.substring(sepIndex + 1);
    }
  }
  
  // Load the user identified by `this.username`, storing it in `this.user`.
  // 
  async retrieveUser(storage: StorageLayer) {
    const userId = {username: this.username};
    
    const user = await bluebird.fromCallback(
      cb => storage.users.findOne(userId, null, cb));
      
    if (user == null) 
      throw errors.unknownResource('user', this.username);
      
    this.user = user; 
  }
        
  // Retrieves the context's access from its token (auth in constructor) and
  // expand its permissions (e.g. to include child streams). Also sets
  // `context.streams`.
  //
  // If the context's access is already set, the initial step is skipped. This
  // allows callers to implement custom retrieval logic if needed (e.g. using a
  // read token for attached files).
  // 
  // This function throws/rejects for various reasons; but it will always throw
  // a subclass of APIError.
  // 
  async retrieveExpandedAccess(storage: StorageLayer) {
    try {
      if (this.access == null) 
        await this.retrieveAccess(storage); 
        
      const access = this.access;
      if (access == null) throw new Error('AF: this.access != null');
      
      // Check if the session is valid; touch it. 
      await this.checkSessionValid(storage);
      
      // Perform the custom auth step.
      const customAuthStep = this.customAuthStepFn;
      if (customAuthStep != null) 
        await this.performCustomAuthStep(customAuthStep);
      
      // Mix in `accessLogic` into our access object. 
      // TODO refactor to not use a mixin; If this fails, it'll be hard to debug.
      _.extend(this.access, accessLogic);
      
      // those 2 last are executed in callbatch for each call.

      // Load the streams we can access.
      await this.retrieveStreams(storage);
      
      // And finally, load permissions for non-personal accesses.
      const streams = this.streams;
      if (!access.isPersonal()) access.loadPermissions(streams);
    }
    catch(err) {
      if (err != null && ! (err instanceof APIError)) {
        throw errors.unexpectedError(err);
      }
      
      // assert: err instanceof APIError
      throw err;
    }
  }
  
  // Internal: Loads `this.access`. 
  // 
  async retrieveAccess(storage: StorageLayer) {
    const token = this.accessToken;

    if (token == null)
      throw errors.invalidAccessToken(
        'The access token is missing: expected an ' +
        '"Authorization" header or an "auth" query string parameter.');
    
    const query = {token: token};
    const access = await bluebird.fromCallback(
      cb => storage.accesses.findOne(this.user, query, null, cb));
      
    if (access == null) 
      throw errors.invalidAccessToken(
        'Cannot find access from token.', 403);
        
    this.access = access; 

    this.checkAccessValid(this.access);            
  }
  
  // Performs validity checks on the given access. You must call this after
  // every access load that needs to return a valid access. Internal function, 
  // since all the 'retrieveAccess*' methods call it. 
  // 
  // Returns nothing but throws if an error is detected.
  // 
  checkAccessValid(access: Access) {
    const now = timestamp.now(); 
    if (access.expires != null && now > access.expires)
      throw errors.forbidden(
        'Access has expired.');
  }
  
  // Loads an access by id or throw an error. On success, assigns to
  // `this.access` and `this.accessToken`. 
  // 
  async retrieveAccessFromId(storage: StorageLayer, accessId: string): Promise<Access> {
    const query = { id: accessId };
    const access = await bluebird.fromCallback(
      cb => storage.accesses.findOne(this.user, query, null, cb));
      
    if (access == null)
      throw errors.invalidAccessToken('Cannot find access matching id.');
      
    this.access = access;
    this.accessToken = access.token;

    this.checkAccessValid(access);
    
    return access;
  }
  
  // Loads session and touches it (personal sessions only)
  async checkSessionValid(storage: StorageLayer) {
    const access = this.access;
    
    if (access == null)
      throw new Error('AF: access != null');
      
    // Only 'personal' tokens expire - if it is not personal, abort. 
    if (access.type !== ACCESS_TYPE_PERSONAL) return; 
    
    // assert: type === 'personal'
    const token = access.token; 
    const session = await bluebird.fromCallback(
      cb => storage.sessions.get(token, cb));
      
    if (session == null)
      throw errors.invalidAccessToken('Access session has expired.', 403);
      
    // Keep the session alive (don't await, see below)
    // TODO Maybe delay/amortize this so that we don't write on every request?
    storage.sessions.touch(token, () => null);
  }

  // Perform custom auth step `customAuthStep`. Errors are caught and rethrown. 
  performCustomAuthStep(customAuthStep: CustomAuthFunction): Promise<void> {
    return new bluebird((res, rej) => {
      try {
        customAuthStep(this, (err) => {
          if (err != null) rej(
            errors.invalidAccessToken(`Custom auth step failed: ${err.message}`));
            
          res(); 
        });
      }
      catch(err) {
        // If the custom auth step throws a synchronous exception, then we dont
        // simply log an auth failure, but rather a server failure: 
        rej(errors.unexpectedError(`Custom auth step threw synchronously: ${err.message}`));
      }
    }); 
  }

  // Loads the users streams as `this.streams`.
  async retrieveStreams(storage: StorageLayer) {
    const user = this.user;
    const streams = await bluebird.fromCallback(
      cb => storage.streams.find(user, {}, null, cb));
    this.streams = streams;
  }

  // Set this contexts stream by looking in this.streams. DEPRECATED.
  // 
  setStreamList(streamIds: array) {
    if (!streamIds || streamIds.length === 0) return;
    streamIds.forEach(function (streamId) {
      let stream = treeUtils.findById(this.streams, streamId);
      if (stream) {
        if (!this.streamList) this.streamList = [];
        this.streamList.push(stream);
      } else {
        this.streamIdsNotFoundList.push(streamId);
      }
    }.bind(this));
  }
  
  /**
 * Sugar for the corresponding access method.
 */
  canReadStream(streamId: string) {
    const access = this.access; 
    if (access == null)
      throw new Error('Access needs to be retrieved first.');
    return access.canReadStream(streamId);
  }

  /**
  * Sugar for the corresponding access method.
  */
  canListStream(streamId: string) {
    const access = this.access;
    if (access == null)
      throw new Error('Access needs to be retrieved first.');
    return access.canListStream(streamId);
  }

  /**
   * Sugar for the corresponding access method.
   */
  canManageStream(streamId: string) {
    const access = this.access; 
    if (access == null)
      throw new Error('Access needs to be retrieved first.');

    return access.canManageStream(streamId);
  }

  /**
   * Sugar for the corresponding access method.
   */
  canReadTag(tag: string) {
    const access = this.access; 
    if (access == null)
      throw new Error('Access needs to be retrieved first.');

    return access.canReadTag(tag);
  }

  /**
   * Sugar for the corresponding access method.
   */
  canManageTag(tag: string) {
    const access = this.access; 
    if (access == null)
      throw new Error('Access needs to be retrieved first.');

    return access.canManageTag(tag);
  }

  /**
   * Whether events in the given stream and tags context can be read.
   *
   * @param streamId
   * @param tags
   * @returns {Boolean}
   */
  canReadContext(streamId: string, tags: ?Array<string>) {
    const access = this.access; 
    if (access == null)
      throw new Error('Access needs to be retrieved first.');

    return access.canReadStream(streamId) &&
      (access.canReadAllTags() ||
        _.some(tags || [], access.canReadTag.bind(this.access)));
  }

  /**
   * Whether events in the given stream and tags context can be updated/deleted.
   *
   * @param streamId
   * @param tags
   * @returns {Boolean}
   */
  canUpdateContext(streamId: string, tags: ?Array<string>) {
    const access = this.access;
    if (access == null)
      throw new Error('Access needs to be retrieved first.');


    return access.canUpdateStream(streamId) ||
      (access.canUpdateTag('*') ||
       _.some(tags || [], access.canUpdateTag.bind(this.access)));
  }

  /**
   * Whether events in the given stream and tags context can be created/updated/deleted.
   *
   * @param streamId
   * @param tags
   * @returns {Boolean}
   */
  canContributeToContext(streamId: string, tags: ?Array<string>) {
    const access = this.access; 
    if (access == null)
      throw new Error('Access needs to be retrieved first.');


    return access.canContributeToStream(streamId) ||
      (access.canContributeToTag('*') ||
        _.some(tags || [], access.canContributeToTag.bind(this.access)));
  }

  initTrackingProperties(item: any, authorOverride: ?string) {
    item.created = timestamp.now();
    item.createdBy = authorOverride || this.getTrackingAuthorId();
    
    return this.updateTrackingProperties(item, authorOverride);
  }

  updateTrackingProperties(updatedData: any, authorOverride: ?string) {
    updatedData.modified = timestamp.now();
    updatedData.modifiedBy = authorOverride || this.getTrackingAuthorId();
    return updatedData;
  }

  // Returns the authorId, formed by the access id and the callerId. 
  // 
  getTrackingAuthorId(): string {
    const access = this.access; 
    if (access == null)
      throw new Error('Access needs to be retrieved first.');

    let authorId = access.id; 
    if (this.callerId != null) {
      authorId += AUTH_SEPARATOR + this.callerId; 
    }
    
    return authorId; 
  }
}
module.exports = MethodContext;
