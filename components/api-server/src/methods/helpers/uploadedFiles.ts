/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { factory as errors } from 'errors';

/**
 * Opening of the files the multipart upload parser wrote for a request.
 *
 * The parser (`middleware/uploads.ts`, with either `MulterIntegrityDiskStorage`
 * or multer's own disk storage) is configured with no destination, so it
 * writes each upload to the operating system temp directory under a random
 * name of 16 bytes in hex. An upload descriptor is only ever produced by that
 * parser, so anything else is refused before the path is opened: a regular
 * file, directly inside that directory, with such a name. The size reported to
 * storage is the size on disk, not the descriptor's.
 */

const UPLOAD_FILENAME = /^[0-9a-f]{32}$/;

/** The directory the upload parser writes to (resolved, as the parser does per file). */
function getUploadTempDir (): string {
  return path.resolve(os.tmpdir());
}

function refusal () {
  return errors.invalidParametersFormat('Invalid attachment upload.');
}

/**
 * Opens an upload descriptor's file for reading.
 * Rejects with `invalid-parameters-format` when the descriptor does not name a
 * regular file written by the upload parser.
 */
async function openUploadedFile (file: { path?: unknown } | null | undefined): Promise<{ stream: ReadStream; size: number }> {
  if (file == null || typeof file.path !== 'string') throw refusal();
  const resolved = path.resolve(file.path);
  if (path.dirname(resolved) !== getUploadTempDir() || !UPLOAD_FILENAME.test(path.basename(resolved))) {
    throw refusal();
  }
  // O_NOFOLLOW: a symlink at that name is not followed (the open fails).
  // O_NONBLOCK: a FIFO at that name cannot block the open; it is refused below.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(resolved, flags);
  } catch {
    throw refusal();
  }
  let size: number | null = null;
  try {
    const stats = await handle.stat();
    if (stats.isFile()) size = stats.size;
  } catch { /* refused below */ }
  if (size == null) {
    await handle.close().catch(() => {});
    throw refusal();
  }
  return { stream: handle.createReadStream(), size };
}

export { getUploadTempDir, openUploadedFile };
