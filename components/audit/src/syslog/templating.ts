/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require('path').dirname(__filename);

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
    // Resolve plugin paths relative to service-core root (config is unified there)
    const rootPath = path.resolve(__dirname, '../../../../');
    this.plugin = require(path.resolve(rootPath, format.plugin));
    logger.debug('Loaded plugin for [' + key + ']: ' + format.plugin);
  }

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

export { loadTemplates, logForEvent };

// ---- utils

/**
 * Get a syslog line from a tenplate + event + userid
 * @param template - of the form "{userid} {content.message}"
 * @param userId  - the userid
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
 */
function getKey (key, obj) {
  return key.split('.').reduce(function (a, b) {
    return a && a[b];
  }, obj);
}
