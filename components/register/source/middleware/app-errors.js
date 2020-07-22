/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
//@flow

var logger = require('winston');
var messages = require('./../utils/messages');

/**
 * Error middleware, may be used for user management
 */
function app_errors(app: express$Application) {
  app.use(function (error, req: express$Request, res, next) { // eslint-disable-line no-unused-vars
    if (error instanceof messages.REGError) {
      //logger.debug('app_errors : '+ JSON.stringify(error.data));
      return res.status(error.httpCode).json(error.data);
    }
    
    // do not log and handle malformed input JSON errors
    if (error instanceof SyntaxError) {
        // custom error format that matches the one used in the core but not in
        // the service-registry
        return res.status(error.status, messages.say('INVALID_JSON_REQUEST')).json(
                {
                    "error": {
                        "id": 'invalid-parameters-format',
                        "message": error.toString()
                    }
                });
    }
    
    if (! (error instanceof Error)) {
      logger.error('app_errors unknown object : ' + error);
      logger.error((new Error()).stack);
    } else {
      logger.error('app_errors : ' + error.toString());
      logger.error(error.stack);
    }
    const err = new messages.REGError(500, messages.say('INTERNAL_ERROR'));
    res.status(err.httpCode).json(err.data);
  });
}

module.exports = app_errors;

