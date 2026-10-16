/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Types for the part of `better-sqlite3` (no published types here) used by
// files that `import` it: the constructor. Files cast the instance to the
// structural `SqliteDb` of ./types.ts, plus the pragma / unsafe-mode calls the
// WAL setup needs.
declare module 'better-sqlite3' {
  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): unknown;
  }
  const Database: DatabaseConstructor;
  export default Database;
}
