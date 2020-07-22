// @flow

var errors = require('components/errors').factory;

/** Transparently handles multipart requests for uploading file attachments.
 *
 * Files uploaded, if any, will be in req.files. All other field parts are 
 * reunited in the body object by multer; after the execution of this middleware, 
 * the `req.body` is replaced by its only child object. If there is more than 
 * one such object in `req.body`, an error is thrown. 
 * 
 * @example
 *    {
 *      event: { foo: 'bar' }
 *    }
 * 
 *    // is turned into
 * 
 *    {
 *      foo: 'bar'
 *    }
 * 
 * @param req {express$Request} request object
 * @param res {express$Response} response object
 * @param next {Function} callback for next middleware in chain
 * @return {void}
 */
function validateFileUpload(req: express$Request, res: express$Response, next: Function) {
  const body = req.body; 

  if (req.is('multipart/form-data') && body != null && typeof body === 'object') 
  {  
    var bodyKeys = Object.keys(body);

    if (bodyKeys.length > 1) {
      return next(errors.invalidRequestStructure(
        'In multipart requests, we don\'t expect more than one non-file part.'));
    }
    if (bodyKeys.length == 0) { 
      return next(); 
    }
    
    // assert: bodyKeys.length === 1
    
    // The only content that is not a file MUST be JSON. 
    try {
      const key = bodyKeys[0];
      const contents = body[key];
      
      if (typeof contents !== 'string') {
        throw new Error('JSON body must be a string.');
      }
      
      req.body = JSON.parse(contents);
    } catch (error) {
      return next(errors.invalidRequestStructure(
        'In multipart requests, we expect the non-file part to be valid JSON.'));
    }
  }

  return next();
}

module.exports = validateFileUpload;
