/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Test helper functions for attached files.
 */
const fs = require('fs');
const path = require('path');
const testData = require('./data');
const { getMall } = require('mall');
// Returns an empty string if the tested file attached to the specified event
// is identical to the original file. (Runs command-line util `cmp`
// underneath).
//
exports.compareTestAndAttachedFiles = async function (user, eventId, fileId, originalFileName) {
  if (originalFileName == null) {
    originalFileName = fileId;
  }
  const mall = await getMall();
  const attachmentStream = await mall.events.getAttachment(user.id, { id: eventId }, fileId);
  const sourceStream = fs.createReadStream(path.join(testData.testsAttachmentsDirPath, originalFileName));
  const attachmentBuffer = await streamToBuffer(attachmentStream);
  const sourceBuffer = await streamToBuffer(sourceStream);

  return Buffer.compare(attachmentBuffer, sourceBuffer) === 0;
};

async function streamToBuffer (readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', data => {
      chunks.push(data);
    });
    readableStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on('error', reject);
  });
}
