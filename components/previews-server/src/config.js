/* jshint -W024 */
var config = require('components/utils').config,
    _ = require('lodash');

/**
 * Extends base config.
 */
module.exports = config;

_.merge(config.schema, {
  http: {
    // override base default
    port: {
      default: 3001
    }
  },
  eventFiles: {
    previewsCacheMaxAge: {
      format: 'duration',
      default: 1000 * 60 * 60 * 24 * 7, // 1 week
      doc: 'The maximum age (in seconds) of a cached preview file if unused.'
    },
    previewsCacheCleanUpCronTime: {
      format: String,
      default: '00 00 2 * * *' // every day at 2:00:00AM
    }
  },
  tcpMessaging: {
    // override base default
    port: {
      default: '4001'
    }
  }
});
