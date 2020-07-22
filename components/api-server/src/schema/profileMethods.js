/**
 * JSON Schema specification of methods data for profile settings.
 */

var helpers = require('./helpers'),
    object = helpers.object,
    string = helpers.string;

var profileData = object({ /* no constraints */ });

module.exports = {

  get: {
    params: object({
      // in path for HTTP requests
      'id': string()
    }, {
      required: [ 'id' ]
    }),
    result: object({
      'profile': profileData
    })
  },

  update: {
    params: object({
      // in path for HTTP requests
      'id': string(),
      // = body of HTTP requests
      'update': profileData
    }, {
      required: [ 'id', 'update' ]
    }),
    result: object({
      'profile': profileData
    }, {
      required: [ 'profile' ]
    })
  }

};
