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
// The method '#version' returns a version string for this project. Resolution
// order:
//
//   1. The '.api-version' file at the project root: its contents are returned
//      as the version string, UNLESS they equal the literal placeholder
//      '1.2.3' (the un-provisioned sentinel). In every real deployment this
//      file is present and non-placeholder, so this branch wins.
//   2. `git describe --tags`: a fallback for git checkouts only. It is
//      structurally UNREACHABLE in a released container: '.git' is excluded by
//      '.dockerignore' and the image ships no 'git' binary. Do not rely on it
//      to make a release self-describe.
//   3. 'unset'.
//
// Because of (2), the file is effectively the single source of truth for the
// API version. The release commit sets the committed '.api-version' to the
// release tag (the tag CI build refuses to publish otherwise), so a native
// install that checks out the tag reports it; Docker release builds also stamp
// the file at build time from the image tag (see the Dockerfile). Checkouts
// between releases report the last release.
//
// The project root is located by looking at the paths in 'process.mainModule'
// (or 'require.main'), trying the first that exists: that is where modules load
// from ('node_modules'), with the '.api-version' file expected as a sibling. An
// ESM fallback walks upward from this source file whenever that search yields
// no '.api-version' sibling, which includes the case where neither is set (as
// under ESM entry points).
//
// Example:
//
//  const pv = new ProjectVersion();
//  pv.version(); // => 2.0.0-rc.20
//

class ProjectVersion {
  // Returns the projects version number.
  //
  version () {
    const version = this.readStaticVersion();
    if (version != null && version !== '1.2.3') { return version; }
    let versionFromGitTag: string | null = null;
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
    const mainModule: { paths?: string[] } | undefined = (process as { mainModule?: { paths?: string[] } }).mainModule || require.main;
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
let version: string | null = null;
async function getAPIVersion (forceRefresh = false) {
  if (!version || forceRefresh) {
    const pv = new ProjectVersion();
    version = pv.version();
  }
  return version;
}
export { ProjectVersion, getAPIVersion };
