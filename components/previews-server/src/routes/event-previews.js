// @flow

const Cache = require('../cache.js');
const childProcess = require('child_process');
const CronJob = require('cron').CronJob;
const errors = require('components/errors').factory;
const gm = require('gm');
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const _ = require('lodash');
const bluebird = require('bluebird');
const getAuth = require('../../../middleware/src/getAuth');

// constants
const StandardDimensions = [ 256, 512, 768, 1024 ];
const SmallestStandardDimension = StandardDimensions[0];
const BiggestStandardDimension = StandardDimensions[StandardDimensions.length - 1];
const StandardDimensionsLength = StandardDimensions.length;

/**
 * Routes for retrieving preview images for events.
 *
 * @param expressApp
 * @param initContextMiddleware
 * @param loadAccessMiddleware
 * @param userEventsStorage
 * @param userEventFilesStorage
 * @param logging
 */
module.exports = function (
  expressApp, initContextMiddleware, loadAccessMiddleware, userEventsStorage,
  userEventFilesStorage, logging) {

  // SERVING PREVIEWS

  expressApp.all('/*', getAuth);

  expressApp.all('/:username/events/*', initContextMiddleware, loadAccessMiddleware);

  expressApp.get('/:username/events/:id:extension(.jpg|.jpeg|)', async function (req, res, next) {
    let originalSize, previewPath;
    let cached = false;
    const context = req.context;
    const user = req.context.user;
    const id = req.params.id;

    try {
      // Check Event
      const event = await bluebird.fromCallback((cb) => userEventsStorage.findOne(user, {id: id}, null, cb));
      if (event == null) { 
        return next(errors.unknownResource('event', id));
      }

      if (! context.canReadContext(event.streamId, event.tags)) {
        return next(errors.forbidden());
      }

      if (! canHavePreview(event)) { 
        return res.sendStatus(204);
      }

      let attachment = getSourceAttachment(event);
      if (attachment == null) {
        throw errors.corruptedData('Corrupt event data: expected an attachment.');
      }

      let attachmentPath = userEventFilesStorage.getAttachedFilePath(context.user, id, attachment.id);

      // Get aspect ratio
      if (attachment.width != null) {
        originalSize = { width: attachment.width, height: attachment.height };
      }

      try {
        originalSize = await bluebird.fromCallback((cb) => gm(attachmentPath).size(cb));
        attachment.width = originalSize.width;
        attachment.height = originalSize.height;
      } catch(err) {
        return next(adjustGMResultError(err));
      }

      await bluebird.fromCallback((cb) => userEventsStorage.updateOne(
        req.context.user, {id: req.params.id},{attachments: event.attachments}, cb));

      // Prepare path
      const targetSize = getPreviewSize(originalSize, {
        width: req.query.width || req.query.w,
        height: req.query.height || req.query.h
      });

      previewPath = await bluebird.fromCallback((cb) => userEventFilesStorage.ensurePreviewPath(
        req.context.user, req.params.id, Math.max(targetSize.width, targetSize.height), cb));

      try {
        const cacheModified = await xattr.get(previewPath, Cache.EventModifiedXattrKey);
        cached = cacheModified.toString() === event.modified.toString();
      } catch (err) {
        // assume no cache (don't throw any error)
      }

      if (! cached) {
        try {
          await bluebird.fromCallback((cb) => gm(attachmentPath + '[0]') // to cover animated GIFs
            .resize(targetSize.width, targetSize.height).noProfile()
            .interlace('Line') // progressive JPEG
            .write(previewPath, cb));
        } catch (err) {
          return next(adjustGMResultError(err));
        }

        await xattr.set(previewPath, Cache.EventModifiedXattrKey, event.modified.toString());

      }

      res.sendFile(previewPath);
      // update last accessed time (don't check result)
      await xattr.set(previewPath, Cache.LastAccessedXattrKey, timestamp.now().toString());
    } catch(err) {
      next(err);
    }
  });

  function canHavePreview(event) {
    return event.type === 'picture/attached';
  }

  function getSourceAttachment(event) {
    // for now: just return the first attachment
    return _.find(event.attachments, function (/*attachment*/) { return true; });
  }

  function adjustGMResultError(err) {
    // assume file not found if code = 1 (gm command result)
    return err.code === 1 ?
      errors.corruptedData('Corrupt event data: expected an attached file.', err) : err;
  }

  function getPreviewSize(original, desired) {
    if (! (desired.width || desired.height)) {
      // return default size
      return { width: SmallestStandardDimension, height: SmallestStandardDimension };
    }

    var originalRatio = original.width / original.height,
        result = {};
    if (! desired.height || desired.width / desired.height > originalRatio) {
      // reference = width
      result.width = adjustToStandardDimension(desired.width);
      result.height = result.width / originalRatio;
    } else {
      // reference = height
      result.height = adjustToStandardDimension(desired.height);
      result.width = result.height * originalRatio;
    }

    // fix if oversize
    if (result.width > BiggestStandardDimension) { result.width = BiggestStandardDimension; }
    if (result.height > BiggestStandardDimension) { result.height = BiggestStandardDimension; }

    return result;
  }

  function adjustToStandardDimension(value) {
    for (var i = 0; i < StandardDimensionsLength; i++) {
      if (value < StandardDimensions[i]) {
        return StandardDimensions[i];
      }
    }
    return StandardDimensions[StandardDimensionsLength - 1];
  }

  // CACHE CLEAN-UP

  var logger = logging.getLogger('previews-cache'),
      workerRunning = false;

  expressApp.post('/clean-up-cache', cleanUpCache);
  expressApp.post('/:username/clean-up-cache', cleanUpCache);

  function cleanUpCache(req, res, next) {
    if (workerRunning) {
      return res.status(200).json({message: 'Clean-up already in progress.'});
    }
    logger.info('Start cleaning up previews cache (on request' +
        (req.headers.origin ? ' from ' + req.headers.origin : '') + ', client IP: ' + req.ip +
        ')...');
    runCacheCleanupWorker(function (err) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      res.status(200).json({message: 'Clean-up successful.'});
    });
  }

  var cronJob = new CronJob({
    cronTime: userEventFilesStorage.settings.previewsCacheCleanUpCronTime || '00 00 2 * * *',
    onTick: function () {
      if (workerRunning) {
        return;
      }

      logger.info('Start cleaning up previews cache (cron job)...');
      runCacheCleanupWorker();
    }
  });
  logger.info('Start cron job for cache clean-up, time pattern: ' + cronJob.cronTime);
  cronJob.start();

  /**
   * @param {Function} callback Optional, will be passed an error on failure
   */
  function runCacheCleanupWorker(callback) {
    callback = (typeof callback === 'function') ? callback : function () {};
    var worker = childProcess.fork(__dirname + '/../runCacheCleanup.js',
      process.argv.slice(2));
    workerRunning = true;
    worker.on('exit', function (code) {
      workerRunning = false;
      callback(code !== 0 ?
        new Error('Cache cleanup unexpectedly failed (see logs for details)') : null);
    });
  }

};
module.exports.injectDependencies = true;
