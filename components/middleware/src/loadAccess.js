// @flow

import type { StorageLayer } from 'components/storage';

// Returns a middleware function that loads the access into `req.context.access`.
// The access is loaded from the token previously extracted by the `initContext` middleware.
// Also, it adds the corresponding access id as a specific response header.
// 
module.exports = function loadAccess(storageLayer: StorageLayer) {
  return async function (
    req: express$Request, res: express$Response, next: express$NextFunction
  ) {

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
 * @param req {express$Request} Current express request.
 * @param res {express$Response} Current express response. MODIFIED IN PLACE.
 */
function setAccessIdHeader (req: express$Request, res: express$Response): express$Response {
  if (req != null) {
    const requestCtx = req.context;
    if (requestCtx != null && requestCtx.access != null) {
      res.header('Pryv-Access-Id', requestCtx.access.id);
    }
  }

  return res;
}