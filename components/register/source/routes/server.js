/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
'use strict';

var checkAndConstraints = require('../utils/check-and-constraints'),
    db = require('../storage/database'),
    messages = require('../utils/messages'),
    config = require('../config');

var logger = require('winston'); 

// patch compatibility issue with winston
// there is a difference between v2.3 and 2.4: .warn() vs .warning()
// forcing the version number in package.json does not seem to fix the issue
// we suspect yarn to load the wrong version
if (logger.warn == null) {
  logger.warn = function(...args) {
    logger.warning(...args);  
  };
}

/** Routes to discover server assignations.
 */
function discoverServerAssignations(app) {
  var domain = '.' + config.get('dns:domain');
  var aaservers_mode = config.get('net:aaservers_ssl') ? 'https' : 'http';

  /** GET /:uid/server - find the server hosting the provided username (uid).
   */
  app.get('/:uid/server', function (req, res, next) {
    var uid = checkAndConstraints.uid(req.params.uid);

    if (! uid) {
      return next(messages.e(400, 'INVALID_USER_NAME'));
    }

    db.getServer(uid, function (error, result) {
      if (error) {
        return next(messages.ei());
      }

      if (!result) {
        return next(messages.e(404, 'UNKNOWN_USER_NAME'));
      }

      return res.redirect(aaservers_mode + '://' + result + '/?username=' + uid);
    });
  });

  /** POST /:uid/server - find the server hosting the provided username (uid)
   */
  app.post('/:uid/server', function (req, res, next) {
    var uid = checkAndConstraints.uid(req.params.uid);

    if (! uid) {
      return next(messages.e(400, 'INVALID_USER_NAME'));
    }

    db.getServer(uid, function (error, result) {
      if (error) {
        return next(messages.ei());
      }
      if(!result) {
        return next(messages.e(404, 'UNKNOWN_USER_NAME'));
      }

      return res.status(200).json({server: result, alias: uid + domain });
    });
  });
}
 
module.exports = discoverServerAssignations;
