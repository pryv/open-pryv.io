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

 /**
  * Pryv Boiler module.
  * @module boiler
  */


const Gifnoc  = require('./config');
const logging = require('./logging');
const airbrake = require('./airbrake');

const config = new Gifnoc();

const boiler = {
  /**
   * notify Airbrake. 
   * If initalize, arguments will be passed to airbrake.notify()
   */
  notifyAirbrake: airbrake.notifyAirbrake,

  /**
   * get a Logger
   * @param {string} name
   * @returns {Logger}
   */
  getLogger: logging.getLogger, 
  /**
   * Prefered way to get the configuration
   * @returns {Promise}
   */
  getConfig: getConfig,
  /**
   * get the configuration. 
   * If the configuration is not fully iniatialized throw an error 
   * @param {boolean} warnOnly - Only warn about potential missuse of config 
   * @returns {Config}
   */
  getConfigUnsafe: getConfigUnsafe ,
  /**
   * Init Boiler, should be called just once when starting an APP
   * @param {Object} options
   * @param {string} options.appName - the name of the Application used by Logger and debug
   * @param {string} [options.baseConfigDir] - (optional) directory to use to look for configs
   * @param {Array<ConfigFile|ConfigRemoteURL|ConfigRemoteURLFromKey|ConfigPlugin>} [options.extraConfigs] - (optional) and array of extra files to load
   * @param {Function} [fullyLoadedCallback] - (optional) called when the config is fully loaded
   */
  init: init, 
}

let logger;
let configIsInitalized = false;
let configInitCalledWithName = null;

function init(options, fullyLoadedCallback) {
  if (configInitCalledWithName) {
    logger.warn('Skipping initalization! boiler is already initialized with appName: ' + configInitCalledWithName)
    return boiler;
  };

  // append the value of process.env.PRYV_BOILER_SUFFIX if present
  options.appNameWithoutPostfix = options.appName;
  if (process.env.PRYV_BOILER_SUFFIX) options.appName += process.env.PRYV_BOILER_SUFFIX;

  logging.setGlobalName(options.appName);
  configInitCalledWithName = options.appName;
  config.initSync({
    baseConfigDir: options.baseConfigDir,
    extras: options.extraConfigs,
    appName: options.appNameWithoutPostfix,
    learnDirectory: process.env.CONFIG_LEARN_DIR
  }, logging);

  logger = logging.getLogger('boiler');
  airbrake.setUpAirbrakeIfNeeded(config, logger);

  config.initASync().then((config) => {
    configIsInitalized = true;
    // airbrake config might come from async settings, so we try twice.
    airbrake.setUpAirbrakeIfNeeded(config, logger);
    if (fullyLoadedCallback) fullyLoadedCallback(config);
  });

  

  
  return boiler
}


async function getConfig() {
  if (! configInitCalledWithName) {
    throw(new Error('boiler must be initalized with init() before using getConfig()'));
  };
  while(! configIsInitalized) {
    await new Promise(r => setTimeout(r, 100)); // wait 100ms
  }
  return config;
}


function getConfigUnsafe(warnOnly) {
  if (! configInitCalledWithName) {
    throw(new Error('boiler must be initalized with init() before using getConfigUnsafe()'));
  };
  if (! configIsInitalized) {
    if (warnOnly) {
      logger.warn('Warning! config loaded before being fully initalized');
    } else {
      throw(new Error('Config loaded before being fully initalized'));
    }
  };
  return config;
}




module.exports = boiler;