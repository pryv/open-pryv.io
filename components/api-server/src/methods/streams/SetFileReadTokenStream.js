var Transform = require('stream').Transform,
    inherits = require('util').inherits,
    utils = require('components/utils');

module.exports = SetFileReadTokenStream;

/**
 * Sets the FileReadToken for each of the given event's attachments (if any) for the given
 * access.
 *
 * @param params
 *        params.access {Object} Access with which the API call was made
 *        params.filesReadTokenSecret {String} available in authSettings
 * @constructor
 */
function SetFileReadTokenStream(params) {
  Transform.call(this, {objectMode: true});

  this.access = params.access;
  this.filesReadTokenSecret = params.filesReadTokenSecret;
}

inherits(SetFileReadTokenStream, Transform);

SetFileReadTokenStream.prototype._transform = function (event, encoding, callback) {

  // To remove when streamId not necessary
  event.streamId = event.streamIds[0];

  if (! event.attachments) {
    this.push(event);
  } else {
    event.attachments.forEach(function (att) {
      att.readToken = utils.encryption
        .fileReadToken(
          att.id, this.access.id, this.access.token,
          this.filesReadTokenSecret);
    }.bind(this));
    this.push(event);
  }
  callback();
};

