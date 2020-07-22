/**
 * Helper for opening inter-process TCP messaging sockets.
 */

var axon = require('axon');

exports.NATS_CONNECTION_URI = 'nats://127.0.0.1:4222';

exports.NATS_WEBHOOKS_CREATE = 'wh.creates';
exports.NATS_WEBHOOKS_ACTIVATE = 'wh.activates';
exports.NATS_WEBHOOKS_DELETE = 'wh.deletes';

exports.NATS_UPDATE_EVENT = 'events.update';
exports.NATS_DELETE_EVENT = 'events.delete';

/**
 * @param {{host: String, port: Number, pubConnectInsteadOfBind: Boolean}} settings
 * @param {Function({Error}, {Object})} callback Called passing the `EventEmitter` for TCP messages
 */
exports.openPubSocket = function (settings, callback) {
  var socket = axon.socket('pub-emitter');
  if (settings.pubConnectInsteadOfBind) {
    socket.connect(+settings.port, settings.host, onSocketOpened);
  } else {
    socket.bind(+settings.port, settings.host, onSocketOpened);
  }

  function onSocketOpened(err) {
    if (err) { return callback(err); }
    callback(null, socket);
  }
};
