/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const winston = require('winston');
// eslint-disable-next-line no-unused-expressions
require('winston-syslog').Syslog; // Exposes `winston.transports.Syslog` (ugly, but it's the recommended way)

const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('audit:syslog');

const templates = require('./templating');

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
  syslogger;

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
    syslogger.add(new winston.transports.Syslog(options));

    this.syslogger = syslogger;
    logger.debug('Initialized');
  }

  /**
   * send an new event for syslog
   * @param {string} userId
   * @param {PryvEvent} event
   */
  eventForUser (userId, event) {
    logger.debug('eventForUser', userId);
    const logItem = templates.logForEvent(userId, event);
    if (logItem != null) {
      this.syslogger.log(logItem);
    }
  }
}

module.exports = Syslog;

/**
 * Generate syslog Format for Winston
 * @param {Object} options
 * @param {boolean} options.color - set to true to have colors
 * @param {boolean} options.time - set to true to for timestamp
 * @param {boolean} options.align - set to true to allign logs items
 */
function generateFormat (options) {
  const formats = [];
  function printf (info) {
    return info.message;
  }
  formats.push(winston.format.printf(printf));
  return winston.format.combine(...formats);
}
