/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
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
