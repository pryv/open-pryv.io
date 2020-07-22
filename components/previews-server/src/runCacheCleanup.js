/**
 * Standalone script to perform cache cleanup.
 * Expects settings to be passed the same way as for the main server.
 */

const Cache = require('./cache.js');
const errorHandling = require('components/errors').errorHandling;
const utils = require('components/utils');
const settings = require('./config').load();
const logger = utils.logging(settings.logs).getLogger('previews-cache-worker');

const cache = new Cache({
  rootPath: settings.eventFiles.previewsDirPath,
  maxAge: (settings.eventFiles.previewsCacheMaxAge / 1000 || 60 * 60 * 24 * 7) / 1000, // 1w
  logger: logger
});

logger.info('Starting clean-up in ' + settings.eventFiles.previewsDirPath);
cache.cleanUp()
  .then(() => {
    logger.info('Clean-up successful.');
    process.exit(0);
  })
  .catch(err => {
    errorHandling.logError(err, null, logger);
    process.exit(1);
  });
