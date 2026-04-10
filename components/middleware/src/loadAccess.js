/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// Returns a middleware function that loads the access into `req.context.access`.
// The access is loaded from the token previously extracted by the `initContext` middleware.
// Also, it adds the corresponding access id as a specific response header.
//
module.exports = function loadAccess (storageLayer) {
  return async function (req, res, next) {
    try {
      await req.context.retrieveExpandedAccess(storageLayer);
      // Add access id header
      setAccessIdHeader(req, res);
      next();
    } catch (err) {
      // Also set the header in case of error
      setAccessIdHeader(req, res);
      next(err);
    }
  };
};
/**
 * Adds the id of the access (if any was used during API call)
 * within the `Pryv-Access-Id` header of the given result.
 * It is extracted from the request context.
 *
 * @param {express$Request} req  Current express request.
 * @param {express$Response} res  Current express response. MODIFIED IN PLACE.
 * @returns {any}
 */
function setAccessIdHeader (req, res) {
  if (req != null) {
    const requestCtx = req.context;
    if (requestCtx != null && requestCtx.access != null) {
      res.header('Pryv-Access-Id', requestCtx.access.id);
    }
  }
  return res;
}
