/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Interface version of each storage type, as this server requires it.
 *
 * An engine declares, per storage type, the version it implements
 * (`interfaceVersions` in its manifest.json; absent counts as 1). The plugin
 * loader refuses to start when a discovered engine's version differs.
 * When to bump, and the history of each number: ./README.md.
 */

const INTERFACE_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  baseStorage: 2,
  dataStore: 1,
  platformStorage: 1,
  seriesStorage: 1,
  fileStorage: 1,
  auditStorage: 1
});

export { INTERFACE_VERSIONS };
