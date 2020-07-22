/**
 * JSON Schema specification of methods data for auth.
 */

var helpers = require('./helpers'),
    object = helpers.object,
    string = helpers.string;

module.exports = {
  login: {
    params: object({
      'username': string(),
      'password': string(),
      'appId': string(),
      'origin': string()
    }, {
      required: [ 'username', 'password', 'appId' ],
      additionalProperties: false
    }),
    result: object({
      'token': string()
    }, {
      required: [ 'token' ],
      additionalProperties: false
    })
  },

  logout: {
    params: object({})
  }
};
