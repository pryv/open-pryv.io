/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plugin to run at the end of the config loading.
 * Should validate (or not) the configuration and display appropriate messages
 */

const { getLogger } = require('@pryv/boiler');
let logger; // initalized at load();

// Fields that MUST be populated in `service:` before the process can start.
// Matches the schema in components/api-server/src/schema/service-info.js —
// `api`, `access`, `register` are auto-populated by the public-url plugin.
//
const REQUIRED_SERVICE_FIELDS = ['name', 'serial', 'home', 'support', 'terms', 'eventTypes'];

async function validate (config) {
  // Collect every validation problem in one pass so the operator sees the
  // full list in a single boot-and-fail cycle instead of one-per-restart.
  const problems = [];

  checkIncompleteFields(config.get(), false, [], null, problems, config);

  const service = config.get('service') || {};
  const missing = REQUIRED_SERVICE_FIELDS.filter(f => !service[f]);
  if (missing.length > 0) {
    problems.push({
      message: 'required service fields missing — /service/info would be invalid. Set them in your override-config.yml under `service:`.',
      path: ['service'],
      payload: { missing, required: REQUIRED_SERVICE_FIELDS }
    });
  }

  return problems;
}

/**
 * Parse all string fields and record a problem for each "REPLACE" sentinel
 * or unresolved `${VAR}` env placeholder. Stops recursing on `active:false`
 * or `enabled:false` blocks.
 *
 * @param {*} obj The object to inspect
 * @param {Array<string>|false} finalPath is !== false the path to access the value (set when passing thru first Array)
 * @param {Array<string>} parentPath path to display in case of error. If in array the index of the array is happened to the path
 * @param {string|null} key the key to construct the path
 * @param {Array<object>} problems accumulator for all problems found
 * @param {object} config the boiler config store (for `getScopeAndValue`)
 */
function checkIncompleteFields (obj, finalPath, parentPath, key, problems, config) {
  const path = key != null ? parentPath.concat(key) : parentPath;
  if (typeof obj === 'undefined' || obj === null) return;
  if (typeof obj === 'string') {
    if (obj.includes('REPLACE')) {
      const queryPath = finalPath || parentPath;
      const res = config.getScopeAndValue(queryPath.join(':'));
      problems.push({ message: 'field content should be replaced', path, payload: res });
    }
    // Unresolved env-var placeholder (`${FOO}`): nothing in the stack expands
    // these, so the literal string reaches consumers and (for paths) creates
    // a literal `${FOO}` directory on disk. Report it.
    const envMatch = obj.match(/\$\{([A-Z_][A-Z0-9_]*)\}/);
    if (envMatch) {
      const queryPath = finalPath || parentPath;
      const res = config.getScopeAndValue(queryPath.join(':'));
      problems.push({
        message: `unresolved env placeholder \${${envMatch[1]}} — export ${envMatch[1]} or replace the literal in config`,
        path,
        payload: { ...res, envVar: envMatch[1] }
      });
    }
  }
  if (typeof obj === 'object') {
    // Skip REPLACE scan on disabled blocks — operators leave `REPLACE ME`
    // sentinels on fields they don't use (e.g. letsEncrypt.{email,atRestKey}
    // when letsEncrypt.enabled=false), and these would otherwise fail-fast
    // the whole startup.
    if (obj.active === false) return;
    if (obj.enabled === false) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        checkIncompleteFields(obj[i], finalPath || parentPath, path, i, problems, config);
      }
    } else {
      for (const k of Object.keys(obj)) {
        checkIncompleteFields(obj[k], finalPath, path, k, problems, config);
      }
    }
  }
}

function formatProblem (p) {
  return 'Configuration is invalid at [' + (p.path || []).join(':') + '] ' + p.message;
}

module.exports = {
  load: async function (store) {
    logger = getLogger('validate-config');
    const problems = await validate(store);
    if (problems.length === 0) return;
    logger.error(`Configuration is invalid — ${problems.length} problem(s) found:`);
    for (const p of problems) {
      logger.error(formatProblem(p), p.payload);
    }
    process.exit(1);
  }
};
