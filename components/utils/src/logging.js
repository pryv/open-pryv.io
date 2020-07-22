// @flow

const winston = require('winston');

// setup logging levels (match logging methods below)
const levels = Object.freeze({
  debug: 3,
  info: 2,
  warn: 1,
  error: 0
});
winston.setLevels(levels);
winston.addColors({
  debug: 'blue',
  info: 'green',
  warn: 'yellow',
  error: 'red'
});

/**
 * Returns a logging singleton providing component-specific loggers.
 * (I.e. wrapper around Winston prefixing log messages with per-component prefixes.)
 *
 * @param logsSettings
 */
module.exports = function (logsSettings: Object) {
  // apply settings

  // (console transport is present by default)
  let consoleSettings = winston['default'].transports.console;
  consoleSettings.silent = ! logsSettings.console.active;
  if (logsSettings.console.active) {
    consoleSettings.level = logsSettings.console.level;
    consoleSettings.colorize = logsSettings.console.colorize;
    consoleSettings.timestamp = logsSettings.console.timestamp || true;
  }
  if (winston['default'].transports.file) {
    // in production env it seems winston already includes a file transport...
    winston.remove(winston.transports.File);
  }
  if (logsSettings.file.active) {
    winston.add(winston.transports.File, {
      level: logsSettings.file.level,
      filename: logsSettings.file.path,
      maxsize: logsSettings.file.maxFileBytes,
      maxFiles: logsSettings.file.maxNbFiles,
      timestamp: true,
      json: false
    });
  }

  // return singleton

  var loggers: Map<string, Logger> = new Map(),
      prefix = logsSettings.prefix;
  return {
    /**
     * Returns a logger for the given component. Keeps track of initialized
     * loggers to only use one logger per component name.
     *
     * @param {String} componentName
     */
    getLogger: function (componentName: string): Logger {
      const context = prefix + componentName;
      
      // Return memoized instance if we have produced it before.
      const existingLogger = loggers.get(context);
      if (existingLogger) return existingLogger;
      
      // Construct a new instance. We're passing winston as a logger here. 
      const logger = new LoggerImpl(context, winston);
      loggers.set(context, logger);
      
      return logger; 
    }, 
  };
};
module.exports.injectDependencies = true; // make it DI-friendly

export interface Logger {
  debug(msg: string, metaData?: {}): void; 
  info(msg: string, metaData?: {}): void;
  warn(msg: string, metaData?: {}): void; 
  error(msg: string, metaData?: {}): void; 
}
export type LogFactory = (topic: string) => Logger; 

class NullLogger implements Logger {
  debug(msg: string, metaData?: {}) { // eslint-disable-line no-unused-vars
  }
  info(msg: string, metaData?: {}) { // eslint-disable-line no-unused-vars
  }
  warn(msg: string, metaData?: {}) { // eslint-disable-line no-unused-vars
  }
  error(msg: string, metaData?: {}) { // eslint-disable-line no-unused-vars
  }
}
module.exports.NullLogger = NullLogger;

class LoggerImpl implements Logger {
  messagePrefix: string; 
  winstonLogger: any; 
  
  /**
   * Creates a new logger for the given component.
   *
   * @param {String} context
   * @constructor
   */
  constructor(context?: string, winstonLogger) {
    this.messagePrefix = context ? '[' + context + '] ' : '';
    this.winstonLogger = winstonLogger;
  }
  
  debug(msg: string, metaData?: {}) {
    this.log('debug', msg, metaData);
  }
  info(msg: string, metaData?: {}) {
    this.log('info', msg, metaData);
  }
  warn(msg: string, metaData?: {}) {
    this.log('warn', msg, metaData);
  }
  error(msg: string, metaData?: {}) {
    this.log('error', msg, metaData);
  }
  
  log(level: string, message: string, metaData?: {}) {
    // Security measure: We do not want any sensitive value to appear in logs
    const msg = hideSensitiveValues(this.messagePrefix + message);
    const meta = metaData ? hideSensitiveValues(JSON.stringify(metaData)) : {};
    
    this.winstonLogger[level](msg, meta);
  }
}

// Hides sensitive values (auth tokens and passwords) in log messages
function hideSensitiveValues (msg) {
  const tokenRegexp = /auth\?=c[a-z0-9-]{24}/g;
  const passwordRegexp = /"(password|passwordHash)"[:=]"([^"]*)"/g;
  const mask = '(hidden)';

  msg = msg
    .replace(tokenRegexp, mask)
    .replace(passwordRegexp, '$1='+mask);
  
  return msg;
}