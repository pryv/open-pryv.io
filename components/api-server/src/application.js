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

// A central registry for singletons and configuration-type instances; pass this
// to your code to give it access to app setup. 

const utils = require('components/utils');
const storage = require('components/storage');

const API = require('./API');

import type { ConfigAccess } from './settings';
import type { WebhooksSettingsHolder } from './methods/webhooks';
import type { LogFactory } from 'components/utils';
import type { Logger } from 'components/utils';

// While we're transitioning to manual DI, we still need to inject some of the 
// stuff here the old way. Hence: 
const dependencies = require('dependable').container({useFnAnnotations: true});

type UpdatesSettingsHolder = {
  ignoreProtectedFields: boolean,
}

// Application is a grab bag of singletons / system services with not many 
// methods of its own. It is the type-safe version of DI. 
// 
class Application {
  // Application settings, see ./settings
  settings: ConfigAccess; 
  
  // Application log factory
  logFactory: LogFactory; 
  
  // Normal user API
  api: API; 
  // API for system routes. 
  systemAPI: API; 
  
  // Storage subsystem
  storageLayer: storage.StorageLayer;
  
  dependencies: typeof dependencies;
  
  constructor(settings: ConfigAccess) {
    this.settings = settings;
    
    this.produceLogSubsystem(); 
    
    this.api = new API(); 
    this.systemAPI = new API(); 
    
    this.produceStorageSubsystem(); 
    
    this.dependencies = dependencies;
    this.registerLegacyDependencies();
  }
  
  produceLogSubsystem() {
    const settings = this.settings;
    const logSystemSettings = settings.get('logs').obj();
    const logging = utils.logging(logSystemSettings); 
    
    this.logFactory = logging.getLogger;
    
    dependencies.register({ logging: logging });
  }
  
  registerLegacyDependencies() {
    const settings = this.settings; 
    
    dependencies.register({
      api: this.api,
      systemAPI: this.systemAPI 
    });

    // DI on the topic of settings and version info
    dependencies.register({
      // settings
      authSettings: settings.get('auth').obj(),
      auditSettings: settings.get('audit').obj(),
      eventFilesSettings: settings.get('eventFiles').obj(),
      eventTypesUrl: settings.get('service.eventTypes').str(),
      httpSettings: settings.get('http').obj(),
      servicesSettings: settings.get('services').obj(),
      updatesSettings: settings.get('updates').obj(),
      openSourceSettings: settings.get('openSource').obj(),
    });
    
    // DI on the topic of storage and MongoDB access
    const sl = this.storageLayer;
    dependencies.register({
      // storage
      versionsStorage: sl.versions,
      passwordResetRequestsStorage: sl.passwordResetRequests,
      sessionsStorage: sl.sessions,
      usersStorage: sl.users,
      userAccessesStorage: sl.accesses,
      userEventFilesStorage: sl.eventFiles,
      userEventsStorage: sl.events,
      userFollowedSlicesStorage: sl.followedSlices,
      userProfileStorage: sl.profile,
      userStreamsStorage: sl.streams,
      
      // and finally, for code that is almost, but not quite there
      storageLayer: sl, 
    });
  }

  produceStorageSubsystem() {
    const settings = this.settings;

    const database = new storage.Database(
      settings.get('database').obj(), 
      this.logFactory('database'));

    // 'StorageLayer' is a component that contains all the vertical registries
    // for various database models. 
    this.storageLayer = new storage.StorageLayer(database, 
      this.logFactory('model'),
      settings.get('eventFiles.attachmentsDirPath').str(), 
      settings.get('eventFiles.previewsDirPath').str(), 
      settings.get('auth.passwordResetRequestMaxAge').num(), 
      settings.get('auth.sessionMaxAge').num(), 
    );
  }
  
  // Returns the settings for updating entities
  // 
  getUpdatesSettings(): UpdatesSettingsHolder {
    const settings = this.settings;
    
    return {
      ignoreProtectedFields: settings.get('updates.ignoreProtectedFields').bool(),
    };
  }

  getWebhooksSettings(): WebhooksSettingsHolder {
    const settings = this.settings;
    return settings.get('webhooks').obj();
  }
  
  getServiceInfoSettings(): ConfigAccess {
    return this.settings;
  }

  // Produces and returns a new logger for a given `topic`.
  // 
  getLogger(topic: string): Logger {
    return this.logFactory(topic);
  }
}

module.exports = Application;
