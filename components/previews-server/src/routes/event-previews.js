/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const fs = require('fs');
const path = require('path');
const Cache = require('../cache');
const childProcess = require('child_process');
const CronJob = require('cron').CronJob;
const errors = require('errors').factory;
const gm = require('gm');
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const _ = require('lodash');
const bluebird = require('bluebird');
const getAuth = require('middleware/src/getAuth');
const { getLogger } = require('@pryv/boiler');
const { getMall } = require('mall');
const attachmentManagement = require('../attachmentManagement');
const { getConfig } = require('@pryv/boiler');

// constants
const StandardDimensions = [256, 512, 768, 1024];
const SmallestStandardDimension = StandardDimensions[0];
const BiggestStandardDimension = StandardDimensions[StandardDimensions.length - 1];
const StandardDimensionsLength = StandardDimensions.length;
/**
 * Routes for retrieving preview images for events.
 *
 * @param expressApp
 * @param initContextMiddleware
 * @param loadAccessMiddleware
 * @param logging
 */
module.exports = async function (expressApp, initContextMiddleware, loadAccessMiddleware, logging) {
  const mall = await getMall();
  const previewsCacheCleanUpCronTime = (await getConfig()).get('eventFiles:previewsCacheCleanUpCronTime') || '00 00 2 * * *';
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
      const event = await mall.events.getOne(user.id, id);
      if (event == null) {
        return next(errors.unknownResource('event', id));
      }
      let canReadEvent = false;
      for (let i = 0; i < event.streamIds.length; i++) {
        // ok if at least one
        if (await context.access.canGetEventsOnStreamAndWithTags(event.streamIds[i], event.tags)) {
          canReadEvent = true;
          break;
        }
      }
      if (!canReadEvent) { return next(errors.forbidden()); }
      if (!canHavePreview(event)) {
        return res.sendStatus(204);
      }

      const attachment = getSourceAttachment(event);
      if (attachment == null) {
        throw errors.corruptedData('Corrupt event data: expected an attachment.');
      }
      const attachmentPath = await attachmentManagement.ensurePreviewPath(req.context.user, req.params.id, 0);
      if (!fs.existsSync(attachmentPath)) { // load file
        const attachmentStream = await mall.events.getAttachment(context.user.id, { id }, attachment.id);
        await fs.promises.writeFile(attachmentPath, attachmentStream);
      }
      await xattr.set(attachmentPath, Cache.LastAccessedXattrKey, timestamp.now().toString());
      // Get aspect ratio
      if (attachment.width != null) {
        originalSize = { width: attachment.width, height: attachment.height };
      }
      try {
        originalSize = await bluebird.fromCallback((cb) => gm(attachmentPath).size(cb));
        attachment.width = originalSize.width;
        attachment.height = originalSize.height;
      } catch (err) {
        return next(adjustGMResultError(err));
      }
      // Prepare path
      const targetSize = getPreviewSize(originalSize, {
        width: req.query.width || req.query.w,
        height: req.query.height || req.query.h
      });
      previewPath = await attachmentManagement.ensurePreviewPath(req.context.user, req.params.id, Math.max(targetSize.width, targetSize.height));
      try {
        const cacheModified = await xattr.get(previewPath, Cache.EventModifiedXattrKey);
        cached = cacheModified.toString() === event.modified.toString();
      } catch (err) {
        // assume no cache (don't throw any error)
      }
      if (!cached) {
        try {
          await bluebird.fromCallback((cb) => gm(attachmentPath + '[0]') // to cover animated GIFs
            .resize(targetSize.width, targetSize.height)
            .noProfile()
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
    } catch (err) {
      next(err);
    }
  });
  function canHavePreview (event) {
    return event.type === 'picture/attached';
  }
  function getSourceAttachment (event) {
    // for now: just return the first attachment
    return _.find(event.attachments, function (/* attachment */) {
      return true;
    });
  }
  function adjustGMResultError (err) {
    // assume file not found if code = 1 (gm command result)
    return err.code === 1
      ? errors.corruptedData('Corrupt event data: expected an attached file.', err)
      : err;
  }
  function getPreviewSize (original, desired) {
    if (!(desired.width || desired.height)) {
      // return default size
      return {
        width: SmallestStandardDimension,
        height: SmallestStandardDimension
      };
    }
    const originalRatio = original.width / original.height; const result = {};
    if (!desired.height || desired.width / desired.height > originalRatio) {
      // reference = width
      result.width = adjustToStandardDimension(desired.width);
      result.height = result.width / originalRatio;
    } else {
      // reference = height
      result.height = adjustToStandardDimension(desired.height);
      result.width = result.height * originalRatio;
    }
    // fix if oversize
    if (result.width > BiggestStandardDimension) {
      result.width = BiggestStandardDimension;
    }
    if (result.height > BiggestStandardDimension) {
      result.height = BiggestStandardDimension;
    }
    return result;
  }
  function adjustToStandardDimension (value) {
    for (let i = 0; i < StandardDimensionsLength; i++) {
      if (value < StandardDimensions[i]) {
        return StandardDimensions[i];
      }
    }
    return StandardDimensions[StandardDimensionsLength - 1];
  }
  // CACHE CLEAN-UP
  const logger = getLogger('previews-cache'); let workerRunning = false;
  expressApp.post('/clean-up-cache', cleanUpCache);
  expressApp.post('/:username/clean-up-cache', cleanUpCache);
  function cleanUpCache (req, res, next) {
    if (workerRunning) {
      return res.status(200).json({ message: 'Clean-up already in progress.' });
    }
    logger.info('Start cleaning up previews cache (on request' +
            (req.headers.origin ? ' from ' + req.headers.origin : '') +
            ', client IP: ' +
            req.ip +
            ')...');
    runCacheCleanupWorker(function (err) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      res.status(200).json({ message: 'Clean-up successful.' });
    });
  }
  const cronJob = new CronJob({
    cronTime: previewsCacheCleanUpCronTime,
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
  function runCacheCleanupWorker (callback) {
    callback = typeof callback === 'function' ? callback : function () { };
    const worker = childProcess.fork(path.resolve(__dirname, '../runCacheCleanup.js'), process.argv.slice(2));
    workerRunning = true;
    worker.on('exit', function (code) {
      workerRunning = false;
      callback(code !== 0
        ? new Error('Cache cleanup unexpectedly failed (see logs for details)')
        : null);
    });
  }
};
