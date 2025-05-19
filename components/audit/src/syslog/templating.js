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

const path = require('path');

const { getLogger } = require('@pryv/boiler');
const logger = getLogger('audit:syslog:templates');

class SyslogTransform {
  key;
  constructor (key) { this.key = key; }
  transform (userId, event) { throw new Error('Transform must be implemented'); }
}

/**
 * Plugin
 * Use external javascript code
 */
class Plugin extends SyslogTransform {
  plugin;

  constructor (key, format) {
    super(key);
    const rootPath = path.resolve(__dirname, '../../');
    this.plugin = require(path.resolve(rootPath, format.plugin));
    logger.debug('Loaded plugin for [' + key + ']: ' + format.plugin);
  }

  /**
   * @param {string} userId
   * @param {PryvEvent} event
   * @returns {LogItem|null} {level: .. , message: ... }  or null to skip
   */
  transform (userId, event) {
    logger.debug('Using plugin ' + this.key);
    return this.plugin(userId, event);
  }
}

/**
 * Templating
 * Transform an event into a syslog message plus level
 */
class Template extends SyslogTransform {
  template;
  level;

  constructor (key, format) {
    super(key);
    this.template = format.template;
    this.level = format.level;
    logger.debug('Loaded template for [' + key + ']: ' + format.template);
  }

  /**
   * @returns {LogItem|null}
   */
  transform (userId, event) {
    logger.debug('Using template ' + this.key);
    return {
      level: this.level,
      message: transformFromTemplate(this.template, userId, event)
    };
  }
}

/**
 * @typedef LogItem
 * @property {string} level - one of: notice, warning, error, critical, alert, emerg
 * @property {string} message
 */

/**
 * Get the Syslog string correspondig to this event
 * @param {string} userId
 * @param {PryvEvent} event
 * @returns {LogItem|null}
 */
function logForEvent (userId, event) {
  if (event.type in templates) {
    return templates[event.type].transform(userId, event);
  }
  return templates['log/default'].transform(userId, event);
}

const templates = {};
function loadTemplates (templatesFromConfig) {
  for (const key of Object.keys(templatesFromConfig)) {
    const format = templatesFromConfig[key];
    if (format.template) {
      templates['log/' + key] = new Template(key, format);
    } else if (format.plugin) {
      templates['log/' + key] = new Plugin(key, format);
    } else {
      throw new Error(`Invalid syslog format [${key}] ${format}`);
    }
  }
}

module.exports = {
  loadTemplates,
  logForEvent
};

// ---- utils

/**
 * Get a syslog line from a tenplate + event + userid
 * @param {string} template - of the form "{userid} {content.message}"
 * @param {string} userId  - the userid
 * @param {PryvEvent} event
 */
function transformFromTemplate (template, userId, event) {
  logger.debug('transformFromTemplate', template);
  const result = template.replace('{userid}', userId);
  return result.replace(/{([^}]*)}/g, function (match, key) {
    let res = getKey(key, event) || match;
    if (typeof res === 'object') {
      res = JSON.stringify(res);
    }
    return res;
  });
}

/**
 * getKey('foo.bar', {foo: { bar: "I want this"}}); //=> "I want this"
 * @param {string} key
 * @param {*} obj
 */
function getKey (key, obj) {
  return key.split('.').reduce(function (a, b) {
    return a && a[b];
  }, obj);
}
