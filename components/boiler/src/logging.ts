/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const util = require('util');
const winston = require('winston');
require('winston-daily-rotate-file');
const debugModule = require('debug');

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type WinstonLogger = {
  add (transport: unknown): void;
  debug (msg: string, meta?: unknown): void;
  info (msg: string, meta?: unknown): void;
  warn (msg: string, meta?: unknown): void;
  error (msg: string, meta?: unknown): void;
  [k: string]: unknown;
};
type CustomLogger = {
  log (level: LogLevel, key: string, message: string, context: unknown): void;
};
type BoilerConfig = {
  get (key: string): any;
  has? (key: string): boolean;
};

let winstonInstance: WinstonLogger | null = null;
let rootLogger: Logger | null = null;
let customLoggerInstance: CustomLogger | null = null;

// ------ winston formating

/**
 *
 * @param options.color - set to true to have colors
 * @param options.time - set to true to for timestamp
 * @param options.align - set to true to allign logs items
 */
function generateFormat (options: { color?: boolean; time?: boolean; align?: boolean }) {
  const formats: unknown[] = [];
  if (options.color) {
    formats.push(winston.format.colorize());
  }
  if (options.time) {
    formats.push(winston.format.timestamp());
  }
  if (options.align) {
    formats.push(winston.format.align());
  }

  function printf (info: { timestamp?: string; level: string; message: string; [k: string | symbol]: unknown }) {
    const { timestamp, level, message } = info;

    let items: any = info[Symbol.for('splat')] || {};

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
      if (!skip) { itemStr = util.inspect(items, { depth: 10, colors: true }); }
    }

    const line = `[${level}]: ${message} ${itemStr}`;

    if (options.time) {
      const ts = (timestamp as string).slice(0, 19).replace('T', ' ');
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
function globalLog (level: LogLevel, key: string, message: string, context: unknown) {
  const text = `[${key}] ${message}`;
  if (winstonInstance) {
    winstonInstance[level](text, context);
  } else {
    console.log('Logger not initialized: ', ...arguments);
  }
  if (customLoggerInstance) {
    customLoggerInstance.log(level, key, message, context);
  }
}

/**
 * Config initialize Logger right after beeing loaded
 * This is done by config Only
 */
async function initLoggerWithConfig (config: BoilerConfig) {
  if (winstonInstance) {
    throw new Error('Logger was already initialized');
  }
  // console
  winstonInstance = winston.createLogger({ });
  const logConsole = config.get('logs:console');
  let isSilent = !config.get('logs:console:active');

  // LOGS env var can override settings
  if (process.env.LOGS) {
    logConsole.level = process.env.LOGS;
    isSilent = false;
  }

  const consoleFormat = generateFormat(logConsole.format);
  const myconsole = new winston.transports.Console({ format: consoleFormat, level: logConsole.level, silent: isSilent });
  winstonInstance!.add(myconsole);

  rootLogger!.debug((isSilent ? '** silent ** ' : '') + 'Console with level: ', logConsole.level);

  // file
  const logFile = config.get('logs:file');
  if (config.get('logs:file:active')) {
    const fileFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    );

    rootLogger!.debug('File active: ' + logFile.path);
    if (logFile.rotation.isActive) {
      const rotatedFiles = new winston.transports.DailyRotateFile({
        filename: logFile.path + '.%DATE%',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        level: logFile.level,
        maxFiles: logFile.rotation.days ? logFile.rotation.days + 'd' : null,
        format: fileFormat
      });
      winstonInstance!.add(rotatedFiles);
    } else {
      const files = new winston.transports.File({
        filename: logFile.path,
        level: logFile.level,
        maxSize: logFile.maxFileBytes || '10m',
        maxFiles: logFile.maxNbFiles || '14d',
        format: fileFormat
      });
      winstonInstance!.add(files);
    }
  }

  // custom
  if (config.get('logs:custom:active')) {
    customLoggerInstance = require(config.get('logs:custom:path'));
    await (customLoggerInstance as unknown as { init: (settings: unknown) => Promise<unknown> }).init(config.get('logs:custom:settings'));
  }

  // catch all errors.
  // In test mode we skip the handler entirely so mocha's own
  // `uncaughtException` listener can mark the active test as failed
  // and proceed. An AssertionError inside a superagent callback
  // (B-2026-05-29-4 family) used to kill the whole worker because
  // this handler ran first and rethrew before mocha saw it.
  if (!config.get('logs:skipUncaughtException') && process.env.NODE_ENV !== 'test') {
    process.on('uncaughtException', function (err) {
      rootLogger!.error('UncaughtException', { message: err.message, name: err.name, stack: err.stack });
      throw err;
    });
  }

  rootLogger!.debug('Logger Initialized');
}

// --------------- debug utils

/**
 * Dump objects with file and line
 */
function inspect (...args: unknown[]): string {
  let line = '';
  try {
    throw new Error();
  } catch (e: unknown) {
    line = (e as Error).stack!.split(' at ')[2].trim();
  }
  let res = '\n * dump at: ' + line;
  for (let i = 0; i < args.length; i++) {
    res += '\n' + i + ' ' + util.inspect(args[i], true, 10, true) + '\n';
  }
  return res;
}

function setGlobalName (name: string) {
  // create root logger
  rootLogger = new Logger(name, null);
  rootLogger.debug('setGlobalName: ' + name);
}

class Logger {
  name: string;
  parent: Logger | null;
  debugInstance: (...args: unknown[]) => void;

  constructor (name: string, parent: Logger | null) {
    this.name = name;
    this.parent = parent;
    this.debugInstance = debugModule('pryv:' + this._name());
  }

  _name (): string {
    if (this.parent) return this.parent._name() + ':' + this.name;
    return this.name;
  }

  log (...args: unknown[]) {
    const level = args[0] as LogLevel;
    const message = hideSensitiveValues(args[1]) as string;
    const context: unknown[] = [];

    let meta;
    for (let i = 2; i < args.length; i++) {
      context.push(inspectAndHide(args[i]));
    }
    if (context.length === 1) {
      meta = { context: context[0] };
    } else if (context.length > 1) {
      meta = { context };
    }
    globalLog(level, this._name(), message, meta);
  }

  info (...args: unknown[]) { this.log('info', ...args); }
  warn (...args: unknown[]) { this.log('warn', ...args); }
  error (...args: unknown[]) { this.log('error', ...args); }
  debug (...args: unknown[]) {
    if (winstonInstance) {
      this.log('debug', ...args);
    }
    this.debugInstance(...args);
  }

  getLogger (name: string): Logger {
    return new Logger(name, this);
  }

  inspect (...args: unknown[]): string { return inspect(...args); }
}

/**
 * Get a new logger, or root loggger if no name is provided
 * @param [name]
 */
function getLogger (name?: string) {
  if (!rootLogger) {
    throw new Error('Initalize boiler before using logger');
  }
  if (!name) {
    return rootLogger;
  }
  return rootLogger.getLogger(name);
}

export { getLogger, setGlobalName, initLoggerWithConfig, inspectAndHide };

// ----------------- Hide sensite data -------------------- //

function inspectAndHide (o: unknown): unknown {
  // Bypass values that don't survive JSON.parse(JSON.stringify()) — passing
  // them through would crash the logger (and the caller) on every log call.
  // - functions: JSON.stringify(fn) returns the string 'undefined' (actually undefined),
  //   then JSON.parse('undefined') throws SyntaxError.
  // - symbols: JSON.stringify(symbol) returns undefined likewise.
  // - any object whose toJSON returns undefined: same shape.
  // - Errors are special-cased upstream by winston, pass through unchanged.
  if (o === undefined || typeof o === 'function' || typeof o === 'symbol') return o;
  if (o instanceof Error) return o;
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(o));
  } catch {
    // Non-round-trippable value (e.g. toJSON returns undefined or a non-JSON
    // primitive). Fall back to the raw value rather than crash.
    return o;
  }
  return _inspectAndHide(cloned);
}

function _inspectAndHide (o: unknown): unknown {
  if (typeof o === 'string') {
    return hideSensitiveValues(o);
  }
  if (o !== null && typeof o === 'object') {
    if (Array.isArray(o)) {
      const res: unknown[] = [];
      for (const item of o) {
        res.push(inspectAndHide(item));
      }
      return res;
    }

    const res: Record<string, unknown> = {};
    const obj = o as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (['password', 'passwordHash', 'newPassword'].includes(key)) {
        res[key] = '(hidden password)';
      } else {
        res[key] = inspectAndHide(obj[key]);
      }
    }
    return res;
  }
  return o;
}

// Hides sensitive values (auth tokens and passwords) in log messages
function hideSensitiveValues (msg: unknown) {
  if (typeof msg !== 'string') return msg;
  const tokenRegexp = /auth=c([a-z0-9-]*)/g;
  const passwordRegexp = /"(password|passwordHash|newPassword)"[:=]"([^"]*)"/g;
  const mask = '(hidden)';

  const res = msg
    .replace(tokenRegexp, 'auth=' + mask)
    .replace(passwordRegexp, '$1=' + mask);

  return res;
}
