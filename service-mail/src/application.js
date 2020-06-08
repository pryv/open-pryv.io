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
// Load configuration file and start the server. 

const assert = require('assert');
const yargs = require('yargs');
const path = require('path');

const logging = require('./logging');
const Context = require('./context');
const Settings = require('./settings');
const Server = require('./server'); 

/** The mailing application holds references to all subsystems and ties everything
 * together. 
 */
class Application {
  
  async initSettings(overrideSettings) {
    this.settings = new Settings(); 

    await this.parseCLargs(process.argv);

    if (overrideSettings != null) {
      this.settings.merge(overrideSettings);
    }
    
    assert(this.settings != null, 'AF: settings init has succeeded');
  }
  
  // Parses the configuration on the command line (arguments).
  // 
  async parseCLargs(argv) {
    const cli = yargs
      .option('c', {
        alias: 'config', 
        type: 'string', 
        describe: 'reads configuration file at PATH'
      })
      .usage('$0 [args] \n\n  starts a metadata service')
      .help();      
    
    const out = cli.parse(argv);
    
    if (out.config != null) {
      const configPath = path.resolve(out.config);
      await this.settings.loadFromFile(configPath);
    }
  }
  
  initLogger() {
    const settings = this.settings;
    const logSettings = settings.get('logs');
    const logFactory = this.logFactory = logging(logSettings).getLogger;
    const logger = this.logger = logFactory('application');
    const consoleLevel = settings.get('logs.console.level');
    
    assert(this.logger != null, 'AF: logger init has succeeded');
    logger.info(`Console logging is configured at level '${consoleLevel}'`);
  }
  
  initContext() {    
    this.context = new Context(this.settings, this.logFactory);
    
    assert(this.context != null, 'AF: context init has succeeded');
    this.logger.info('Context initialized.');
  }
  
  async setup(overrideSettings) {
    
    await this.initSettings(overrideSettings);
    this.initLogger();
    this.initContext();
    
    this.server = new Server(this.settings, this.context);
    
    return this; 
  }
  
  async run() {
    await this.server.start(); 
  }
  
  async close() {
    await this.server.stop(); 
  }
}

module.exports = Application; 
