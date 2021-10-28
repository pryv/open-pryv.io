/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
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
 */
// @flow

// A central registry for singletons and configuration-type instances; pass this
// to your code to give it access to app setup. 

const path = require('path');
const boiler = require('@pryv/boiler').init({
  appName: 'api-server',
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'serviceInfo',
    key: 'service',
    urlFromKey: 'serviceInfoUrl'
  },{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/paths-config.js')
  },{
    plugin: require('../config/components/systemStreams')
  },{
    plugin: require('../config/public-url')
  }, {
    scope: 'default-audit',
    file: path.resolve(__dirname, '../../audit/config/default-config.yml')
  }, {
    scope: 'default-audit-path',
    file: path.resolve(__dirname, '../../audit/config/default-path.js')
  }, {
    plugin: require('../config/config-validation')
  }]
});

const storage = require('storage');
const API = require('./API');
const expressAppInit = require('./expressApp');
const middleware = require('middleware');
const errorsMiddlewareMod = require('./middleware/errors'); 

const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('application');
const UserLocalDirectory = require('business').users.UserLocalDirectory;

const { Extension, ExtensionLoader } = require('utils').extension;

const { getAPIVersion } = require('middleware/src/project_version');
const { tracingMiddleware } = require('tracing');

logger.debug('Loading app');

import type { CustomAuthFunction } from 'business';
import type { WebhooksSettingsHolder }  from './methods/webhooks';

type UpdatesSettingsHolder = {
  ignoreProtectedFields: boolean,
}

// Application is a grab bag of singletons / system services with not many 
// methods of its own. It is the type-safe version of DI. 
// 
class Application {
  // new config
  config;
  logging;

  initalized;
  initializing; 

  
  // Normal user API
  api: API; 
  // API for system routes. 
  systemAPI: API; 
  
  database: storage.Database;

  // Storage subsystem
  storageLayer: storage.StorageLayer;
  
  expressApp: express$Application;

  isOpenSource: boolean;
  isAuditActive: boolean;

  constructor() {
    this.initalized = false;
    this.isOpenSource = false;
    this.isAuditActive = false;
    this.initializing = false;
  }

  async initiate() {
    while (this.initializing) { await new Promise(r => setTimeout(r, 50)); }
    if (this.initalized) {
      logger.debug('App was already initialized, skipping');
      return this;
    }
    this.initializing = true;
    this.produceLogSubsystem();
    logger.debug('Init started');
    await UserLocalDirectory.init();

    this.config = await getConfig();
    this.isOpenSource = this.config.get('openSource:isActive');
    this.isAuditActive = (! this.isOpenSource) && this.config.get('audit:active')
    
    if (this.isAuditActive) {
      const audit = require('audit');
      await audit.init();
    }

    this.api = new API(); 
    this.systemAPI = new API(); 
    
    this.produceStorageSubsystem(); 
    await this.createExpressApp();
    const apiVersion: string = await getAPIVersion();
    const hostname: string = require('os').hostname();
    this.expressApp.use(tracingMiddleware(
      'express1',
      {
        apiVersion,
        hostname,
      }
    ))
    this.initiateRoutes();
    this.expressApp.use(middleware.notFound);
    const errorsMiddleware = errorsMiddlewareMod(this.logging);
    this.expressApp.use(errorsMiddleware);
    logger.debug('Init done');
    this.initalized = true;
    if (this.config.get('showRoutes')) this.helperShowRoutes();
    this.initializing = false;
    return this;
  }

  /**
   * Helps that display all routes and methodId registered
   */
  helperShowRoutes() {
    let route;
    const routes = [];
    function addRoute(route) {
      if (route) {
        let methodId;
        for (let layer of route.stack ) {
          if (layer.handle.name === 'setMethodId') {
            const fakeReq = {};
            layer.handle(fakeReq, null, function() {});
            methodId = fakeReq.context.methodId;
          }
        }
        let keys = Object.keys(route.methods);
        if (keys.length > 1) keys = ['all'];
        routes.push({methodId: methodId, path: route.path, method: keys[0]})
      }
    }

    this.expressApp._router.stack.forEach(function(middleware){
      if(middleware.route){ // routes registered directly on the app
          addRoute(middleware.route);
      } else if(middleware.name === 'router'){ // router middleware 
          middleware.handle.stack.forEach(h => addRoute(h.route));
      }
    });
    console.log(routes);
  }

  async createExpressApp(): Promise<express$Application> {
    this.expressApp = await expressAppInit(this.logging);
  }

  initiateRoutes() {
    
    if (this.config.get('dnsLess:isActive')) {
      require('./routes/register')(this.expressApp, this);
    }
    
    // system, root, register and delete MUST come first
    require('./routes/auth/delete')(this.expressApp, this);
    require('./routes/auth/register')(this.expressApp, this);
    if (this.isOpenSource) {
      require('www')(this.expressApp, this);
      require('register')(this.expressApp, this);
    }
    
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

    
    if(! this.isOpenSource) {
      require('./routes/webhooks')(this.expressApp, this);
    }
    if(this.isAuditActive) {
      require('audit/src/routes/audit.route')(this.expressApp, this);
    }
  }
  
  produceLogSubsystem() {
    this.logging = getLogger('Application'); 
  }

  produceStorageSubsystem() {
    this.database = storage.getDatabaseSync();
    // 'StorageLayer' is a component that contains all the vertical registries
    // for various database models. 
    this.storageLayer = storage.getStorageLayerSync()
  }

   // Returns the custom auth function if one was configured. Otherwise returns
  // null. 
  // 
  customAuthStepLoaded = false;
  customAuthStepFn = null;
  getCustomAuthFunction(from): ?CustomAuthFunction {
    if (! this.customAuthStepLoaded) {
      this.customAuthStepFn = this.loadCustomExtension();
      this.customAuthStepLoaded = true;
    }
    logger.debug('getCustomAuth from: ' + from + ' => ' + (this.customAuthStepFn !== null), this.customAuthStep);
    return this.customAuthStepFn;
  }

  loadCustomExtension(): ?Extension {
    const defaultFolder = this.config.get('customExtensions:defaultFolder');
    const name = 'customAuthStepFn';
    const customAuthStepFnPath = this.config.get('customExtensions:customAuthStepFn');

    const loader = new ExtensionLoader(defaultFolder);
  
    let customAuthStep = null;
    if ( customAuthStepFnPath) {
      logger.debug('Loading CustomAuthStepFn from ' + customAuthStepFnPath);
      customAuthStep = loader.loadFrom(customAuthStepFnPath);
    } else {
      // assert: no path was configured in configuration file, try loading from 
      // default location:
      logger.debug('Trying to load CustomAuthStepFn from ' + defaultFolder + '/'+ name + '.js');
      customAuthStep = loader.load(name);
    }
    if (customAuthStep) {
      logger.debug('Loaded CustomAuthStepFn');
      return customAuthStep.fn;
    } else {
      logger.debug('No CustomAuthStepFn');
    }
  }

}

let app;
/**
 * get Application Singleton
 * @param {boolean} forceNewApp - In TEST mode only, return a new Application for fixtures and mocks
 * @returns 
 */
function getApplication(forceNewApp) {
  if (forceNewApp || ! app)  {
    app = new Application();
  }
  return app;
}

module.exports = {
  getApplication
}