/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const conformanceTests = require('storages/interfaces/fileStorage/conformance/EventFiles.test').default;

// An S3-compatible store must be reachable for these tests; they skip
// themselves otherwise. Local dev: a MinIO container —
//   docker run -d --name minio-test -p 9000:9000 minio/minio server /data
const S3_TEST = {
  endpoint: process.env.S3_TEST_ENDPOINT || 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: process.env.S3_TEST_BUCKET || 'pryv-test-attachments',
  accessKeyId: process.env.S3_TEST_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.S3_TEST_SECRET_KEY || 'minioadmin',
  forcePathStyle: true,
  keyPrefix: 'conformance-test/'
};

const noopLogger = { debug () {}, info () {}, warn () {}, error () {} };

describe('[S3EF] S3 EventFiles conformance', () => {
  let db;

  before(async function () {
    // Any HTTP response (including 403 XML) proves the endpoint is up.
    try {
      await fetch(S3_TEST.endpoint, { signal: AbortSignal.timeout(2000) });
    } catch (e) {
      this.skip();
    }

    const { _internals } = require('../src/_internals.ts');
    _internals.set('config', S3_TEST);
    _internals.set('getLogger', () => noopLogger);

    // Ensure the test bucket exists.
    const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      endpoint: S3_TEST.endpoint,
      region: S3_TEST.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: S3_TEST.accessKeyId,
        secretAccessKey: S3_TEST.secretAccessKey
      }
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: S3_TEST.bucket }));
    } catch (e) {
      if (e?.name !== 'BucketAlreadyOwnedByYou' && e?.name !== 'BucketAlreadyExists') throw e;
    }
    client.destroy();
  });

  conformanceTests(async () => {
    const { EventS3Files } = require('../src/EventS3Files.ts');
    db = new EventS3Files();
    await db.init();
    return db;
  }, async (userId) => {
    if (db) await db.removeAllForUser(userId);
  });
});
