/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * 
 */
// @flow

// Gathers all the repositories into one big object for convenience. 

const bluebird = require('bluebird');

import type { Logger } from 'components/utils';
import type Database from './Database';

const Versions = require('./Versions');
const PasswordResetRequests = require('./PasswordResetRequests');
const Sessions = require('./Sessions');
const Accesses = require('./user/Accesses');
const EventFiles = require('./user/EventFiles');
const Events = require('./user/Events');
const FollowedSlices = require('./user/FollowedSlices');
const Profile = require('./user/Profile');
const Streams = require('./user/Streams');
const Webhooks = require('./user/Webhooks');

const { getConfig, Config } = require('components/api-server/config/Config');
const config: Config = getConfig();

class StorageLayer {
  connection: Database; 
  
  versions: Versions;
  passwordResetRequests: PasswordResetRequests;
  sessions: Sessions;
  accesses: Accesses;
  eventFiles: EventFiles;
  events: Events;
  followedSlices: FollowedSlices;
  profile: Profile;
  streams: Streams;
  webhooks: Webhooks;
  
  constructor(
    connection: Database, 
    logger: Logger, 
    attachmentsDirPath: string,
    previewsDirPath: string,
    passwordResetRequestMaxAge: number,
    sessionMaxAge: number,
  ) {
    this.connection = connection;
    
    this.versions = new Versions(
      connection, 
      attachmentsDirPath, 
      logger);
    this.passwordResetRequests = new PasswordResetRequests(
      connection,
      { maxAge: passwordResetRequestMaxAge });
    this.sessions = new Sessions(
      connection, 
      { maxAge: sessionMaxAge });
    this.accesses = new Accesses(connection);
    this.eventFiles = new EventFiles(
      { 
        attachmentsDirPath: attachmentsDirPath, 
        previewsDirPath: previewsDirPath,
      }, 
      logger);  
    this.events = new Events(connection);
    this.followedSlices = new FollowedSlices(connection);
    this.profile = new Profile(connection);
    this.streams = new Streams(connection);
    this.webhooks = new Webhooks(connection);
  }
  
  async waitForConnection() {
    const database = this.connection;
    
    return bluebird.fromCallback(
      (cb) => database.waitForConnection(cb));
  }
}
module.exports = StorageLayer;