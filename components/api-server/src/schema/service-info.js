/**
 * JSON Schema specification for events.
 */

const helpers = require('./helpers');
const object = helpers.object;
const string = helpers.string;

exports = module.exports = function () {

  const schema = object({
    'serial': string(),
    'api': string(),
    'access': string(),
    'register': string(),
    'name': string(),
    'home': string(),
    'support': string(),
    'terms': string(),
    'eventTypes': string(),
    'assets': object({})
  }, {
    required: ['serial', 'api', 'access', 'register', 'name', 'home', 'support', 'terms', 'eventTypes'],
    additionalProperties: false
  });

  return schema;
};
