/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const winston = require('winston');
// eslint-disable-next-line no-unused-expressions
require('winston-syslog').Syslog; // Exposes `winston.transports.Syslog` (ugly, but it's the recommended way)

const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('audit:syslog');

const templates = require('./templating.ts');

/**
 * Supported messages are:
 * - emerg : Emergency
 * - alert : Alert
 * - critical : Critical
 * - error: Error
 * - warning: Warning
 * - notice: Notice
 */
class Syslog {
  syslogger: any;

  async init () {
    if (this.syslogger) {
      throw new Error('Syslog logger was already initialized');
    }

    const config = await getConfig();
    const options = config.get('audit:syslog:options');
    const templateSetings = config.get('audit:syslog:formats');
    // templates
    templates.loadTemplates(templateSetings);

    // console
    const syslogger = winston.createLogger({
      levels: winston.config.syslog.levels,
      format: generateFormat(options.format)
    });
    // uncomment the following line to get syslog output to console
    // syslogger.add(new winston.transports.Console());
    const syslogTransport = new winston.transports.Syslog(options);
    // The transport's underlying unix-dgram socket emits 'error' on first send
    // when the configured socket path (default /dev/log) doesn't exist —
    // common in containerized deploys with no syslog daemon. Without a
    // listener, Writable.emit('error', err) throws synchronously, crashing
    // the api-server worker on the first audited request. Best-effort
    // observability instead of a load-bearing path.
    syslogTransport.on('error', (err: any) => logger.warn('audit syslog dropped', err));
    syslogger.add(syslogTransport);

    this.syslogger = syslogger;
    logger.debug('Initialized');
  }

  /**
   * send an new event for syslog
   */
  eventForUser (userId: any, event: any) {
    logger.debug('eventForUser', userId);
    const logItem = templates.logForEvent(userId, event);
    if (logItem != null) {
      this.syslogger.log(logItem);
    }
  }
}

export default Syslog;
export { Syslog };

/**
 * Generate syslog Format for Winston
 * @param options.color - set to true to have colors
 * @param options.time - set to true to for timestamp
 * @param options.align - set to true to allign logs items
 */
function generateFormat (options: any) {
  const formats: any[] = [];
  function printf (info: any) {
    return info.message;
  }
  formats.push(winston.format.printf(printf));
  return winston.format.combine(...formats);
}
