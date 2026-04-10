/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const timestamp = require('unix-timestamp');
const _ = require('lodash');
const { getAPIVersion } = require('middleware/src/project_version');
// cnan be overriden;
const { getConfig } = require('@pryv/boiler');
// NOTE There's really no good way to wait for an asynchronous process in a
//  synchronous method. But we don't want to modify all the code that uses
//  setCommonMeta either; ideally, we'd have a chain of dependencies leading
//  here and this would have some state. Then we could load the version once
//  and store it forever. This (init and memoise) is the next best thing.
// Memoised copy of the current project version.
let version = 'n/a';
let serial = null;
let config = null;
/**
 *
 * If no parameter is provided, loads the configuration. Otherwise takes the provided loaded settings.
 */
module.exports.loadSettings = async function () {
  config = await getConfig();
  version = await getAPIVersion();
};
/**
 * Adds common metadata (API version, server time) in the `meta` field of the given result,
 * initializing `meta` if missing.
 *
 * Warning : the new `settings` parameter is a slight "hack" (almost like `version`)
 * to set and cache the serial when core starts.
 * We REALLY should refactor this method.
 *
 * @param result {Object} Current result. MODIFIED IN PLACE.
 */
module.exports.setCommonMeta = function (result) {
  if (result.meta == null) {
    result.meta = {};
  }
  if (serial == null && config != null) {
    serial = config.get('service:serial');
  }
  _.extend(result.meta, {
    apiVersion: version,
    serverTime: timestamp.now(),
    serial
  });
  return result;
};

/**
 * @typedef {{
 *   meta: {
 *     apiVersion: string;
 *     serverTime: number;
 *     serial: string;
 *   };
 * }} MetaInfo
 */
