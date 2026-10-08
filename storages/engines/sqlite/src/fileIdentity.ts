/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { stat } from 'node:fs/promises';

/**
 * Identity (device + inode) of the file at `filePath`, or null when it does
 * not exist. A file removed and created again under the same path gets
 * another identity.
 *
 * Per-user SQLite files are shared by several processes (API and HFS
 * workers, the backup / restore tools), and each process caches open
 * handles on them. SQLite keeps serving an unlinked file through an open
 * handle, so a cached handle is reused only while the identity of the path
 * still matches the one recorded when the handle was opened.
 */
async function fileIdentity (filePath: string): Promise<string | null> {
  try {
    const st = await stat(filePath, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export { fileIdentity };
