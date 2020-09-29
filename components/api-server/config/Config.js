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

const nconf = require('nconf');
const components = require('./components');
const defaultConfig = require('./defaultConfig').defaultConfig;

let config = null;

function getConfig(): Config {
  if (config == null) {
    config = new Config();
  }
  return config;
}
module.exports = { getConfig };

export type { Config };

class Config {

  store: {};

  isInitialized: boolean = false;
  isInitializing: boolean = false;

  logger: {};
  notifier: {};

  configFile: string;

  constructor() {
    this.initializeConfig();
  }

  initializeConfig () {
    // TODO set logger

    const store = new nconf.Provider();

    // get config from arguments and env variables
    // memory must come first for config.set() to work without loading config files
    // 1. `process.env`
    // 2. `process.argv`
    store.use('memory').argv().env();

    // 3. Values in `config.json`
    if (store.get('config')) {
      this.configFile = store.get('config')
    } else if (store.get('NODE_ENV')) {
      this.configFile = 'config/' + store.get('NODE_ENV') + '.json';
    } else {
      this.configFile = 'config/development.json';
    }

    store.file({ file: this.configFile });

    // remove this when config is loaded in all tests before other components that use it. See commits:
    // - f7cc95f70aae87ebb0776f94256c14eeec54baa3
    // - a0e31f8f8dd4b9756635d80923143e256ccd0077
    components.systemStreams.load(store).then();

    this.store = store;
    this.setDefaults();
  }

  async init () {
    if (this.isInitializing && ! isTest()) return new Error('config.init() called twice.');
    this.isInitializing = true;
    await loadComponents(this.store);
    this.isInitialized = true;
    this.isInitializing = false;
  }

  /**
   * For tests it is usuaful to reset initial config after the 
   * test was finished
   */
  async resetConfig () {
    if (isTest()){
      this.initializeConfig();
    } else {
      console.log('To reset the config is only allowed in tests');
    }
  }

  get(key: string): any {
    if (! this.isInitialized && ! isTest()) return new Error('calling config.get() before it is initialized.');
    return this.store.get(key);
  }

  set(key: string, value: string): void {
    if (! this.isInitialized && ! isTest()) return new Error('calling config.set() before it is initialized.');
    this.store.set(key, value);
  }

  getLogger(prefix: string): any {
    return this.logger;
  }
  
  setDefaults (): void {
    this.store.defaults(defaultConfig);
  }
}

function isTest(): boolean {
  return process.env.NODE_ENV === 'test'
}

async function loadComponents (store: any): any {
  const comps = Object.values(components);
  for(let i=0; i < comps.length; i++) {
    await comps[i].load(store);
  }
  return store;
}
