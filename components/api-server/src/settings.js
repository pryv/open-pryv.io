/* eslint-disable no-console */
// @flow


const { Extension, ExtensionLoader } = require('components/utils').extension;
// FLOW __dirname can be undefined when node is run outside of file.
const config = require(__dirname + '/config');

const { ExistingValue, MissingValue } = require('components/utils/src/config/value');

const wwwPath = require('./routes/Paths').WWW;

opaque type ConvictConfig = Object;

import type { CustomAuthFunction } from 'components/model';
import type { ConfigValue } from 'components/utils/src/config/value';

export interface ConfigAccess {
  get(key: string): ConfigValue;
  has(key: string): boolean;
  getCustomAuthFunction(): ?CustomAuthFunction;
}

export type { ConfigValue };

let settingsSingleton = null;

// Handles loading and access to project settings. 
//
class Settings implements ConfigAccess {
  convict: ConvictConfig;
  customAuthStepFn: ?Extension;
  registerLoaded: boolean;
  isLoading: Boolean;



  // Loads the settings for production use. This means that we follow the order
  // defined in config.load. 
  // 
  // Additionally, you can pass `configLocation` which will override the env
  // and the command line arguments. 
  //
  static async load(configLocation: ?string): Promise<Settings> {
    if (settingsSingleton) {
      return settingsSingleton;
    }
    config.printSchemaAndExitIfNeeded();
    const ourConfig = await config.setupWithServiceInfo(configLocation);
    settingsSingleton = new Settings(ourConfig);

    // I was not able to find a better place  -- to be changed 
    if (ourConfig.get('dnsLess.isActive')) {
      let publicUrl = ourConfig.get('dnsLess.publicUrl');
      if (publicUrl.slice(-1) === '/') publicUrl = publicUrl.slice(0, -1);
      ourConfig.set('auth.passwordResetPageURL', publicUrl + wwwPath + '/access/reset-password.html');
    }

    settingsSingleton.maybePrint();
    return settingsSingleton;
  }


  /**
   * CONSTRUCTOR
   * 
   * @param {*} ourConfig 
   */
  constructor(ourConfig: ConvictConfig) {
    this.convict = ourConfig;
    this.registerLoaded = false;
    this.customAuthStepFn = this.loadCustomExtension();
  }

  maybePrint() {
    const shouldPrintConfig = this.get('printConfig').bool();

    if (shouldPrintConfig) {
      console.info('Configuration settings loaded', this.convict.get()); // eslint-disable-line no-console
    }
  }
  loadCustomExtension(): ?Extension {
    const defaultFolder = this.get('customExtensions.defaultFolder').str();
    const name = 'customAuthStepFn';
    const customAuthStepFnPath = this.get('customExtensions.customAuthStepFn');

    const loader = new ExtensionLoader(defaultFolder);

    if (!customAuthStepFnPath.blank())
      return loader.loadFrom(customAuthStepFnPath.str());

    // assert: no path was configured in configuration file, try loading from 
    // default location:
    return loader.load(name);
  }

  /** Returns the value for the configuration key `key`.  
   * 
   * Example: 
   * 
   *    settings.get('logs.console.active') //=> true
   *
   * @return {ExistingValue} Returns the configuration value that corresponds to 
   *    `key` given. 
   * @throws {Error} If the key you're trying to access doesn't exist in the 
   *    configuration. This is a hard error, since we have a schema that the 
   *    configuration file corresponds to. 
   * 
   */
  get(key: string): ConfigValue {
    const configuration = this.convict;

    if (!configuration.has(key))
      return Settings.missingValue(key);

    // assert: `config` contains a value for `key`
    const value = configuration.get(key);
    return Settings.existingValue(key, value);
  }

  // Returns true if the given key exists in the configuration, false otherwise. 
  // 
  has(key: string): boolean {
    return this.convict.has(key) && this.convict.get(key) != null;
  }

  // Returns the custom auth function if one was configured. Otherwise returns
  // null. 
  // 
  getCustomAuthFunction(): ?CustomAuthFunction {
    if (this.customAuthStepFn == null) return null;

    return this.customAuthStepFn.fn;
  }

  static missingValue(key: string): ConfigValue {
    return new MissingValue(key);
  }
  static existingValue(key: string, value: mixed): ConfigValue {
    return new ExistingValue(key, value);
  }

  /**
   * Add or update a config value if the `value` is not null.
   *
   * @param {string} : memberName
   * @param {Object} : value
   */
  setConvictMember(memberName: string, value: Object) {
    if (!value) {
      return;
    }
    this.convict.set(memberName, value);
  }
}
module.exports = Settings;
