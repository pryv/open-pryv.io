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
