module.exports = MigrationContext;

/**
 * Context and helpers for data migrations.
 *
 * @param {Object} settings
 * @constructor
 */
function MigrationContext(settings) {
  this.database = settings.database;
  this.attachmentsDirPath = settings.attachmentsDirPath;
  this.logger = settings.logger;
}

MigrationContext.prototype.stepCallbackFn = function (context, stepDone) {
  return function (err) {
    if (err) {
      this.logError(err, context);
      return stepDone(err);
    }
    stepDone();
  }.bind(this);
};

MigrationContext.prototype.logInfo = function (message) {
  this.logger.info(message);
};

MigrationContext.prototype.logError = function (err, stepDescription) {
  this.logger.error('Error ' + stepDescription + ': ' + err.stack);
};
