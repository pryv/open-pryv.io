/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Retrieves the projects version from git and from our deploy process.
const path = require('path');
const fs = require('fs');
const API_VERSION_FILENAME = '.api-version';
const DEFAULT_VERSION = 'unset';
const { execSync } = require('child_process');
// The method '#version' returns a version string for this project; it
// determines it using the following:
//
//   If the project contains a file called '.api-version' at its root,
//   the contents of the file are returned as version string.
//   Take care to strip newlines from the file.
//
// The way we find the project root is as follows: Look at the paths in
// 'process.mainModule' - and try to find the first one which does exist. This
// is where we load our modules from ('node_modules') and we'll expect the
// .api-version file to be a sibling.
//
// Example:
//
//  const pv = new ProjectVersion();
//  pv.version(); // => 1.2.3
//

class ProjectVersion {
  // Returns the projects version number.
  //
  version () {
    const version = this.readStaticVersion();
    if (version != null && version !== '1.2.3') { return version; }
    let versionFromGitTag: any = null;
    try {
      const options = { stdio: 'pipe' }; // in order to mute stderr from console stdout. https://stackoverflow.com/a/45578119/3967660
      versionFromGitTag = execSync('git describe --tags', options).toString();
      if (versionFromGitTag) { versionFromGitTag = versionFromGitTag.trim(); }
    } catch (e) {
      // remove log because we don't want it to appear in CI logs
    }
    return versionFromGitTag || version || DEFAULT_VERSION;
  }

  readStaticVersion () {
    // Sources, in priority order:
    //   1. `process.mainModule.paths` siblings (CJS entry point)
    //   2. `require.main.paths` (also CJS-only but distinct from mainModule)
    //   3. Walk upward from this file's own location (ESM-safe fallback
    //      — many forked entry points are ESM, where both mainModule
    //      and require.main are undefined; without this fallback
    //      project_version returns the git-describe stamp which breaks
    //      consumers expecting a `1.2.3`-shaped version string).
    // process.mainModule was deprecated and removed from @types/node;
    // the fallback chain is intentional for legacy CJS contexts.
    const mainModule: any = (process as any).mainModule || require.main;
    const searchPaths: string[] = (mainModule && mainModule.paths) || [];
    for (const current of searchPaths) {
      const rootPath = path.dirname(current);
      const versionFilePath = path.join(rootPath, API_VERSION_FILENAME);
      if (!fs.existsSync(versionFilePath)) { continue; }
      return fs.readFileSync(versionFilePath).toString();
    }
    // ESM fallback — walk upward from the directory containing this source
    // file looking for an .api-version sibling. Stops at filesystem root.
    let dir = __dirname;
    for (let i = 0; i < 16; i++) {
      const candidate = path.join(dir, API_VERSION_FILENAME);
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate).toString();
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }
}
let version: any = null;
async function getAPIVersion (forceRefresh = false) {
  if (!version || forceRefresh) {
    const pv = new ProjectVersion();
    version = pv.version();
  }
  return version;
}
export { ProjectVersion, getAPIVersion };
