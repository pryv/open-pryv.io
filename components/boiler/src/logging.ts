/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const util = require('util');
const fs = require('node:fs');
const nodePath = require('node:path');
const winston = require('winston');
const Transport = require('winston-transport');
require('winston-daily-rotate-file');
const debugModule = require('debug');

/**
 * A file transport that writes each entry with `fs.appendFileSync`.
 *
 * Winston's stock File / DailyRotateFile transports buffer through an
 * async stream: entries still in that buffer are LOST when the process
 * ends via `process.exit()` — which is exactly what a mocha run does
 * (`exit: true`). The consequence is a silent one: a server-side error
 * is logged, the process exits, and the line never reaches the disk, so
 * the failure looks causeless.
 *
 * A synchronous write cannot be lost that way. It costs an fs call per
 * entry, so this transport is meant for LOW-VOLUME levels (warn/error) —
 * keep the chatty levels on the async transport above. Enable via
 * `logs:fileSync:active`.
 */
class SyncFileTransport extends Transport {
  filePath: string;
  constructor (opts: { filePath: string; level?: string }) {
    super(opts as never);
    this.filePath = opts.filePath;
    ensureLogDir(this.filePath);
  }

  log (info: Record<string, unknown>, callback: () => void): void {
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        level: info.level,
        pid: process.pid,
        message: info.message,
      };
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { mode: LOG_FILE_MODE });
    } catch (_e) {
      // Logging must never throw back into the caller's path.
    }
    callback();
  }
}

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
  // Typing the config getter cascades to every config.get() call site —
  // belongs to a dedicated config-typing pass, not here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get (key: string): any;
  has? (key: string): boolean;
};

// Set by init() before any getLogger() consumer runs — the `!` uses below
// rely on that boot ordering.
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- winston splat payload, heterogeneous by design
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
 * Structured console format: one JSON object per line, with `level`,
 * `name`, `pid` (and timestamp/message/context) as proper fields so
 * log-based alerting can query e.g. `WHERE level = 'error'` — the
 * human-readable text lines are unparseable for collectors.
 *
 * Activated via `logs:console:format:json: true` or `LOG_FORMAT=json`.
 */
function generateJsonFormat () {
  function printf (info: { timestamp?: string; level: string; message: string; [k: string | symbol]: unknown }) {
    const { timestamp, level, message } = info;
    // globalLog always prefixes the logger name as `[a:b:c] ` — lift it
    // back out into a proper field (names never contain `]`).
    let name: string | undefined;
    let msg = message;
    const m = /^\[([^\]]*)\] /.exec(message);
    if (m) { name = m[1]; msg = message.slice(m[0].length); }

    const entry: Record<string, unknown> = { timestamp, level, name, pid: process.pid, message: msg };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- winston splat payload, heterogeneous by design
    const items: any = info[Symbol.for('splat')] || [];
    if (items.length === 1 && items[0] && items[0].context !== undefined) {
      entry.context = items[0].context;
    } else if (items.length > 0 && items[0] !== undefined) {
      entry.context = items.length === 1 ? items[0] : items;
    }
    return JSON.stringify(entry);
  }
  return winston.format.combine(winston.format.timestamp(), winston.format.printf(printf));
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

// Log files carry client addresses, usernames and e-mail addresses: created
// readable by the owner and its group only, in a directory others cannot enter.
// (Modes apply when the file or the directory is created; existing ones keep theirs.)
const LOG_FILE_MODE = 0o640;
const LOG_DIR_MODE = 0o750;

function ensureLogDir (filePath: string): void {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true, mode: LOG_DIR_MODE });
}

/**
 * `logs.file.rotation.maxSize` for winston-daily-rotate-file: a number with a
 * `k` / `m` / `g` unit (`'10m'`). That library turns any other string into "no
 * limit" without a word, so an unreadable value is reported here instead.
 */
function rotationMaxSize (value: unknown): string | null {
  if (value == null || value === '') return null;
  // The library reads `0k` as "no limit": a cap must be at least 1.
  if (typeof value === 'string' && /^[1-9]\d*[kmg]$/i.test(value)) return value.toLowerCase();
  rootLogger?.warn('logs.file.rotation.maxSize ignored: expected a size such as "10m", got ' + JSON.stringify(value));
  return null;
}

/**
 * The file transports set by `logs:file` and `logs:fileSync` (none when both
 * are inactive).
 */
function createFileTransports (config: BoilerConfig): unknown[] {
  const transports: unknown[] = [];
  const logFile = config.get('logs:file');
  if (config.get('logs:file:active')) {
    const fileFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    );

    rootLogger?.debug('File active: ' + logFile.path);
    ensureLogDir(logFile.path);
    const fileOptions = { flags: 'a', mode: LOG_FILE_MODE };
    if (logFile.rotation?.isActive) {
      const rotateOptions: Record<string, unknown> = {
        filename: logFile.path + '.%DATE%',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        level: logFile.level,
        maxFiles: logFile.rotation.days ? logFile.rotation.days + 'd' : null,
        format: fileFormat,
        options: fileOptions
      };
      // Only when set: the library names its audit file (the list of files it
      // prunes) after a hash of these options, so an extra key, even null,
      // would orphan the existing audit and stop pruning the files it lists.
      const maxSize = rotationMaxSize(logFile.rotation.maxSize);
      if (maxSize != null) rotateOptions.maxSize = maxSize;
      transports.push(new winston.transports.DailyRotateFile(rotateOptions));
    } else {
      // No rotation means one growing file (rotate it outside, e.g. logrotate).
      // No size options here: winston's `File` size rollover loses entries
      // logged in a burst, and the size cap belongs to `rotation.maxSize`.
      transports.push(new winston.transports.File({
        filename: logFile.path,
        level: logFile.level,
        format: fileFormat,
        options: fileOptions
      }));
    }
  }

  // sync file — a loss-proof trail for the levels you cannot afford to
  // miss. Separate from `logs:file` above on purpose: that one keeps the
  // high-volume async stream, this one guarantees delivery even when the
  // process is killed with process.exit() before the stream drains.
  const fileSync = config.get('logs:fileSync');
  if (fileSync?.active) {
    transports.push(new SyncFileTransport({
      filePath: fileSync.path,
      level: fileSync.level || 'warn',
    }));
    rootLogger?.debug('Sync file active: ' + fileSync.path);
  }
  return transports;
}

/**
 * Whether a log target other than the console is configured: `logs:file`,
 * `logs:fileSync` or `logs:custom`.
 */
function hasLogTarget (config: BoilerConfig): boolean {
  return !!(config.get('logs:file:active') || config.get('logs:fileSync:active') || config.get('logs:custom:active'));
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

  // LOG_FORMAT env var can force the structured console output
  const jsonMode = process.env.LOG_FORMAT === 'json' || logConsole.format?.json === true;
  const consoleFormat = jsonMode ? generateJsonFormat() : generateFormat(logConsole.format);
  // `logs.console.stderr`: every level on stderr, for a CLI whose stdout is
  // its output (e.g. `bin/mail.js templates get > file`).
  let stderrLevels = config.get('logs:console:stderr') === true ? Object.keys(winston.config.npm.levels) : undefined;
  let consoleLevel = logConsole.level;
  // No log target at all (console silent, no file, no custom logger): the
  // warnings and errors would be lost. Send them to stderr instead, where
  // the service manager (journal, `docker logs`) keeps them.
  if (isSilent && !hasLogTarget(config)) {
    isSilent = false;
    consoleLevel = 'warn';
    stderrLevels = Object.keys(winston.config.npm.levels);
  }
  const myconsole = new winston.transports.Console({ format: consoleFormat, level: consoleLevel, silent: isSilent, stderrLevels });
  winstonInstance!.add(myconsole);

  rootLogger!.debug((isSilent ? '** silent ** ' : '') + 'Console with level: ', consoleLevel);

  // files
  for (const transport of createFileTransports(config)) {
    winstonInstance!.add(transport);
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
  // used to kill the whole worker because
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
  debugInstance: ((...args: unknown[]) => void) & { enabled?: boolean };

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
    // An Error as the message (`logger.error(err, err)`) prints as "Name: message".
    const message = hideSensitiveValues(args[1] instanceof Error ? String(args[1]) : args[1]) as string;
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
    // `DEBUG=pryv:*` output gets the same masking as the other levels.
    if (this.debugInstance.enabled) {
      this.debugInstance(...args.map((a) => typeof a === 'string' ? hideSensitiveValues(a) : inspectAndHide(a)));
    }
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
  if (o === undefined || typeof o === 'function' || typeof o === 'symbol') return o;
  // An Error stays an Error (printed with its stack), its message, stack,
  // fields and cause masked.
  if (o instanceof Error) return maskError(o, 0);
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(o, errorsAsPlainObjects));
  } catch {
    // Non-round-trippable value (e.g. toJSON returns undefined or a non-JSON
    // primitive). Fall back to the raw value rather than crash.
    return o;
  }
  return _inspectAndHide(cloned);
}

const MAX_NESTED_ERRORS = 5;

function maskError (e: Error, depth: number): Error {
  const masked = new Error(hideSensitiveValues(e.message) as string);
  Object.defineProperty(masked, 'name', { value: e.name, writable: true, configurable: true, enumerable: false });
  masked.stack = hideSensitiveValues(e.stack) as string;
  const fields = e as unknown as Record<string, unknown>;
  const out = masked as unknown as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = hiddenValue(key);
    } else {
      // A getter that throws leaves the field out.
      try { out[key] = maskNested(fields[key], depth); } catch { out[key] = '(not logged)'; }
    }
  }
  const cause = (e as { cause?: unknown }).cause;
  if (cause !== undefined && !Object.prototype.propertyIsEnumerable.call(e, 'cause')) {
    Object.defineProperty(masked, 'cause', { value: maskNested(cause, depth), writable: true, configurable: true, enumerable: false });
  }
  return masked;
}

// A value held by an Error (a field, the cause); nested Errors are bounded.
// An object that cannot be masked (circular, e.g. an HTTP client's request
// with its headers) is left out rather than printed as is.
function maskNested (value: unknown, depth: number): unknown {
  if (value instanceof Error) return depth < MAX_NESTED_ERRORS ? maskError(value, depth + 1) : '(not logged)';
  if (value !== null && typeof value === 'object') {
    try { JSON.stringify(value, errorsAsPlainObjects); } catch { return '(not logged)'; }
  }
  return inspectAndHide(value);
}

// JSON.stringify replacer: an Error nested in a logged object keeps its
// name, message, stack, fields and cause (JSON would reduce it to its fields).
function errorsAsPlainObjects (_key: string, value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  const plain: Record<string, unknown> = { name: value.name, message: value.message, stack: value.stack };
  Object.assign(plain, value);
  const cause = (value as { cause?: unknown }).cause;
  if (cause !== undefined) plain.cause = cause;
  return plain;
}

function hiddenValue (key: string): string {
  return key.toLowerCase().includes('password') ? '(hidden password)' : '(hidden)';
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
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        res[key] = hiddenValue(key);
      } else {
        res[key] = inspectAndHide(obj[key]);
      }
    }
    return res;
  }
  return o;
}

// Keys whose values are credentials, compared lower-cased. (Not `code`: it
// names error codes far more often than authorization codes.)
const SENSITIVE_KEYS = new Set(['password', 'passwordhash', 'newpassword', 'oldpassword', 'resettoken',
  'recoverycode', 'token', 'emailproof', 'invitationtoken', 'secret', 'handoff', 'refreshtoken',
  'accesstoken', 'authorization', 'mfatoken', 'key', 'readtoken', 'passphrase', 'adminaccesskey',
  'filesreadtokensecret', 'atrestkey', 'piihmackey', 'access_token', 'refresh_token', 'id_token',
  'client_secret', 'clientsecret', 'code_verifier', 'cookie', 'set-cookie']);

// Hides sensitive values (auth tokens, passwords, credentials in URLs) in log messages
function hideSensitiveValues (msg: unknown) {
  if (typeof msg !== 'string') return msg;
  const tokenRegexp = /auth=([^&\s"']+)/g;
  const passwordRegexp = /"(password|passwordHash|newPassword|oldPassword|resetToken|recoveryCode|token|emailProof|invitationToken|mfaToken|refreshToken|accessToken|readToken|passphrase|adminAccessKey|access_token|refresh_token|id_token|client_secret|code_verifier)"[:=]"([^"]*)"/g;
  // URL user info: `https://<token>@host/` (an API endpoint) or `//user:pass@host`
  const userinfoRegexp = /\/\/[^/@\s"']+@/g;
  const mask = '(hidden)';

  const res = msg
    .replace(tokenRegexp, 'auth=' + mask)
    .replace(passwordRegexp, '$1=' + mask)
    .replace(userinfoRegexp, '//' + mask + '@');

  return res;
}
