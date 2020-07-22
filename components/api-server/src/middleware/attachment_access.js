// @flow

const lodash = require('lodash');

const storage = require('components/storage');
const errors = require('components/errors').factory;

function middlewareFactory(userEventsStorage: storage.user.Events) {
  return lodash.partial(attachmentsAccessMiddleware, userEventsStorage);
}
module.exports = middlewareFactory;

// A middleware that checks permissions to access the file attachment, then
// translates the request's resource path to match the actual physical path for
// static-serving the file.
// 
function attachmentsAccessMiddleware(userEventsStorage, req, res, next) {
  userEventsStorage.findOne(req.context.user, {id: req.params.id}, null, function (err, event) {
    const _ = lodash; 
    
    if (err) {
      return next(errors.unexpectedError(err));
    }
    if (! event) {
      return next(errors.unknownResource('event', req.params.id));
    }
    if (! req.context.canReadStream(event.streamId)) {
      return next(errors.forbidden());
    }

    req.url = req.url
      .replace(req.params.username, req.context.user.id)
      .replace('/events/', '/');
      
    if (req.params.fileName) {
      // ignore filename (it's just there to help clients build nice URLs)
      var encodedFileId = encodeURIComponent(req.params.fileId);
      req.url = req.url.substr(0, req.url.indexOf(encodedFileId) + encodedFileId.length);
    }

    // set response content type (we can't rely on the filename)
    const attachment = event.attachments ?
      _.find(event.attachments, {id: req.params.fileId}) : null;
    if (! attachment) {
      return next(errors.unknownResource(
        'attachment', req.params.fileId
      ));
    }
    res.header('Content-Type', attachment.type);

    next();
  });
}
