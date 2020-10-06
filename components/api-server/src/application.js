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
const expressAppInit = require('./expressApp');
const middleware = require('components/middleware');
const errorsMiddlewareMod = require('./middleware/errors'); 
const config = require('./config');

const { getConfig, Config } = require('components/api-server/config/Config');

import type { ConfigAccess } from './settings';
import type { WebhooksSettingsHolder } from './methods/webhooks';
import type { LogFactory } from 'components/utils';
import type { Logger } from 'components/utils';

type UpdatesSettingsHolder = {
  ignoreProtectedFields: boolean,
}

type AirbrakeSettings = {
  projectId: string, key: string,
};

// Application is a grab bag of singletons / system services with not many 
// methods of its own. It is the type-safe version of DI. 
// 
class Application {
  // Application settings, see ./settings
  settings: ConfigAccess; 
  // new config
  config: Config;
  
  logging: Logger

  // Application log factory
  logFactory: LogFactory; 
  
  // Normal user API
  api: API; 
  // API for system routes. 
  systemAPI: API; 
  
  database: storage.Database;

  // Storage subsystem
  storageLayer: storage.StorageLayer;
  
  expressApp: express$Application;

  constructor(settings: ConfigAccess) {
    this.settings = settings;
    
    this.api = new API(); 
    this.systemAPI = new API(); 
    
    this.produceLogSubsystem(); 
    this.produceStorageSubsystem();
    this.config = getConfig();
  }

  async initiate() {
    await this.config.init();
    this.produceLogSubsystem(); 
    this.produceStorageSubsystem(); 
    await this.createExpressApp();
    this.initiateRoutes();
    this.expressApp.use(middleware.notFound);
    const errorsMiddleware = errorsMiddlewareMod(this.logging, createAirbrakeNotifierIfNeeded());
    this.expressApp.use(errorsMiddleware);
  }

  async createExpressApp(): Promise<express$Application> {
    this.expressApp = await expressAppInit( 
      this.settings.get('singleNode.isActive').bool(), 
      this.logging);
  }

  initiateRoutes() {
    const isOpenSource = this.settings.get('openSource.isActive').bool();
    if (isOpenSource) {
      require('components/www')(this.expressApp, this);
      require('components/register')(this.expressApp, this);
    }
    if (this.settings.get('singleNode.isActive').bool()) {
      require('./routes/register')(this.expressApp, this);
    }

    // system, root, register and delete MUST come firs
    require('./routes/auth/delete')(this.expressApp, this);
    require('./routes/auth/register')(this.expressApp, this);
    require('./routes/system')(this.expressApp, this);
    require('./routes/root')(this.expressApp, this);
    
    require('./routes/accesses')(this.expressApp, this);
    require('./routes/account')(this.expressApp, this);
    require('./routes/auth/login')(this.expressApp, this);
    require('./routes/events')(this.expressApp, this);
    require('./routes/followed-slices')(this.expressApp, this);
    require('./routes/profile')(this.expressApp, this);
    require('./routes/service')(this.expressApp, this);
    require('./routes/streams')(this.expressApp, this);

    if(!isOpenSource) require('./routes/webhooks')(this.expressApp, this);
  }
  
  produceLogSubsystem() {
    const logSystemSettings = this.settings.get('logs').obj();
    this.logging = utils.logging(logSystemSettings); 
    
    this.logFactory = this.logging.getLogger;
  }

  produceStorageSubsystem() {
    const settings = this.settings;

    this.database = new storage.Database(
      settings.get('database').obj(), 
      this.logFactory('database'));

    // 'StorageLayer' is a component that contains all the vertical registries
    // for various database models. 
    this.storageLayer = new storage.StorageLayer(this.database, 
      this.logFactory('model'),
      settings.get('eventFiles.attachmentsDirPath').str(), 
      settings.get('eventFiles.previewsDirPath').str(), 
      settings.get('auth.passwordResetRequestMaxAge').num(), 
      settings.get('auth.sessionMaxAge').num()
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

function createAirbrakeNotifierIfNeeded() {
  /*
    Quick guide on how to test Airbrake notifications (under logs entry):
    1. Update configuration file with Airbrake information:
        "airbrake": {
         "active": true,
         "key": "get it from pryv.airbrake.io settings",
         "projectId": "get it from pryv.airbrake.io settings"
       }
    2. Throw a fake error in the code (/routes/root.js is easy to trigger):
        throw new Error('This is a test of Airbrake notifications');
    3. Trigger the error by running the faulty code (run a local core)
   */
  const settings = getAirbrakeSettings(); 
  if (settings == null) return; 

  const { Notifier } = require('@airbrake/node');

  const airbrakeNotifier = new Notifier({
    projectId: settings.projectId,
    projectKey: settings.key,
    environment: 'production',
  });
  return airbrakeNotifier;
}

function getAirbrakeSettings(): ?AirbrakeSettings {
  // TODO Directly hand log settings to this class. 
  const logSettings = config.load().logs;
  if (logSettings == null) return null; 
  
  const airbrakeSettings = logSettings.airbrake;
  if (airbrakeSettings == null || !airbrakeSettings.active) return null; 
  
  const projectId = airbrakeSettings.projectId;
  const key = airbrakeSettings.key;
  if (projectId == null || key == null) return null; 
  
  return {
    projectId: projectId, 
    key: key,
  };
}

module.exports = Application;
