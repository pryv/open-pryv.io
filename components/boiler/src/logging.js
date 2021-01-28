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
const util = require('util');
const winston = require('winston');
const debugModule = require('debug');
let winstonInstance = null;
let rootLogger = null;

// ------ winston formating

/**
 * 
 * @param {Object} options 
 * @param {boolean} options.color - set to true to have colors
 * @param {boolean} options.time - set to true to for timestamp
 * @param {boolean} options.align - set to true to allign logs items
 */
function generateFormat(options) {
  const formats = [];
  if (options.color) {
    formats.push(winston.format.colorize());
  } 
  if (options.time) {
    formats.push(winston.format.timestamp());
  }
  if (options.align) {
    formats.push(winston.format.align());
  }

  function printf(info) {
    const {
      timestamp, level, message, ...args
    } = info;
    
    let items = info[Symbol.for('splat')] || {};
    
    let itemStr = '';
    if (items.length > 0) {
      let skip = false;
      if (items.length === 1) {
        if (typeof items[0] === 'undefined') {
          skip = true;
        } else {
          if (items[0] && items[0].context) { 
            items = items[0].context;
          } 
        }
      }
      if (! skip)
        itemStr = util.inspect(items, {depth: 10, colors: true});
    }



    const line = `[${level}]: ${message} ${itemStr}`;

    if (options.time) {
      const ts = timestamp.slice(0, 19).replace('T', ' ');
      return ts + ' ' + line;
    } else {
      return line;
    }
  }
  formats.push(winston.format.printf(printf));
  return winston.format.combine(...formats);
}



/**
 * Helper to pass log instructions to winston
 */
function globalLog(level, text, context) { 
  if (winstonInstance) {
    winstonInstance[level](text, context);
  } else {
    console.log('Logger not initialized: ', ...arguments);
  }
}


/**
 * Config initialize Logger right after beeing loaded
 * This is done by config Only
 */ 
async function initLoggerWithConfig(config) { 
  if (winstonInstance) {
    throw new Error("Logger was already initialized");
  }
  // console
  winstonInstance = winston.createLogger({ });
  const logConsole = config.get('logs:console');
  let isSilent = ! config.get('logs:console:active');

  // LOGS env var can override settings
  if (process.env.LOGS) {
    logConsole.level = process.env.LOGS;
    isSilent = false;
  } 


  const format = generateFormat(logConsole.format)
  const myconsole = new winston.transports.Console({ format: format , level: logConsole.level, silent: isSilent});
  winstonInstance.add(myconsole);
  
  rootLogger.debug((isSilent ?  '** silent ** ' : '') + 'Console with level: ', logConsole.level);

  // file
  const logFile = config.get('logs:file');
  if (config.get('logs:file:active')) {
    rootLogger.debug('File active: ' + logFile.path);
    const files = new winston.transports.File({ 
      filename: logFile.path,
      level: logFile.level,
      maxsize: logFile.maxFileBytes,
      maxFiles: logFile.maxNbFiles,
      timestamp: true,
      json: false
    });
    winstonInstance.add(files);
  }
  rootLogger.debug('Logger Initialized');
};



// --------------- debug utils 

/**
 * Dump objects with file and line
 */
function inspect() {
  let line = '';
  try {
    throw new Error();
  } catch (e) {
    line = e.stack.split(' at ')[2].trim();
  }
  let res = '\n * dump at: ' + line;
  for (var i = 0; i < arguments.length; i++) {
    res += '\n' + i + ' ' + util.inspect(arguments[i], true, 10, true) + '\n';
  }
  return res;
};


function setGlobalName(name) {
  // create root logger
  rootLogger = new Logger(name, null);
  rootLogger.debug('setGlobalName: ' + name);
}


class Logger {
  parent; // eventual parent
  debugInstance; // debug instance

  constructor(name, parent) {
    this.name = name;
    this.parent = parent;
    this.debugInstance =  debugModule('pryv:' + this._name());
  }
  /**
   * Private
   */
  _name() {
    if (this.parent) return this.parent._name() + ':' + this.name;
    return this.name;
  }

  log() {
    const level = arguments[0];
    const text = '[' + this._name() + ']: ' + hideSensitiveValues(arguments[1]);
    const context = [];

    let meta;
    // Security measure: We do not want any sensitive value to appear in logs
    for (let i = 2; i < arguments.length; i++) {
      context.push(inspectAndHide(arguments[i]));
    }
    if (context.length === 1) {
      meta = {context:  context[0]};
    } else if (context.length > 1) {
      meta = {context:  context};
    }
    globalLog(level, text, meta);
  }

  info () { this.log('info', ...arguments); }
  warn () { this.log('warn', ...arguments); }
  error () { this.log('error', ...arguments); }
  debug () { 
    if (winstonInstance) {
      this.log('debug', ...arguments); 
    }
    this.debugInstance(...arguments); 
  } 

  /**
   * get a "sub" Logger
   * @param {Logger} name 
   */
  getLogger (name) {
    return new Logger(name, this);
  }

  inspect() { inspect(...arguments); }
}

function getLogger(name) {
  if (! rootLogger) {
    throw new Error('Initalize boiler before using logger')
  }
  if(! name) {
    return rootLogger;
  }
  return rootLogger.getLogger(name);
}

module.exports = {
  getLogger: getLogger,
  setGlobalName: setGlobalName,
  initLoggerWithConfig: initLoggerWithConfig
}

// ----------------- Hide sensite data -------------------- //

function inspectAndHide(o) {
  if (typeof o === 'undefined') return o;
  if (o instanceof Error) return o;
  return _inspectAndHide(JSON.parse(JSON.stringify(o))); // clone and remove circular
}

function _inspectAndHide(o) {
  if (typeof o === 'string') {
    return hideSensitiveValues(o);
  }
  if (o !== null && typeof o === 'object') {
    if (Array.isArray(o)) {
      const res = [];
      for (let item of o) {
        res.push(inspectAndHide(item));
      }
      return res;
    }

    const res = {};
    for (let key of Object.keys(o)) {
      if (['password', 'passwordHash'].includes(key)) {
        res[key] = '(hidden password)';
      } else {
        res[key] = inspectAndHide(o[key]);
      }
    }
    return res;
  }
  return o;
}


// Hides sensitive values (auth tokens and passwords) in log messages
function hideSensitiveValues (msg) {
  if (typeof msg !== 'string') return msg;
  const tokenRegexp = /auth\=c([a-z0-9-]*)/g;
  const passwordRegexp = /"(password|passwordHash)"[:=]"([^"]*)"/g;
  const mask = '(hidden)';

  const res = msg
    .replace(tokenRegexp, 'auth='+mask)
    .replace(passwordRegexp, '$1='+mask);
  
  return res;
}