/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const errors = require('errors').factory;
const { USERNAME_REGEXP_STR } = require('api-server/src/schema/helpers');
/**
 * Middleware to translate the subdomain (i.e. username) in requests (if any) into the URL path,
 * e.g. path "/streams" on host ignace.pryv.io becomes "/ignace/streams".
 * Accepts a list of paths to ignore (e.g. /register, /socket.io), and does not add the
 * username again if it is already present as the path root.
 *
 * TODO: this responsibility should be moved out to the reverse proxy (e.g. Nginx)
 *
 * @param {Array} ignoredPaths Paths for which no translation is needed
 * @return {Function}
 */
module.exports = function (ignoredPaths, ignoredSubdomains) {
  ignoredSubdomains = ignoredSubdomains || [];
  return function (req, res, next) {
    if (isIgnoredPath(req.url)) {
      return next();
    }
    if (!req.headers.host) {
      return next(errors.missingHeader('Host'));
    }
    const hostChunks = req.headers.host.split('.');
    // For security reasons, don't allow inserting anything into path unless it
    // looks like a user name.
    const firstChunk = hostChunks[0];
    if (!looksLikeUsername(firstChunk)) { return next(); }
    // Skip core's own subdomain in multi-core mode
    if (ignoredSubdomains.includes(firstChunk)) { return next(); }
    // Skip if it is already in the path.
    const pathPrefix = `/${firstChunk}`;
    if (req.url.startsWith(pathPrefix)) { return next(); }
    req.url = pathPrefix + req.url;
    next();
  };
  function isIgnoredPath (url) {
    return ignoredPaths.some(function (ignoredPath) {
      return url.startsWith(ignoredPath);
    });
  }
};
/**
 * @param {string} candidate
 * @returns {boolean}
 */
function looksLikeUsername (candidate) {
  const reUsername = new RegExp(USERNAME_REGEXP_STR);
  const lowercasedUsername = candidate.toLowerCase(); // for retro-compatibility
  return reUsername.test(lowercasedUsername);
}
