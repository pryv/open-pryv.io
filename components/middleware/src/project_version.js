/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * 
 */
// @flow

// Retrieves the projects version from git and from our deploy process. 

const path = require('path');
const fs = require('fs');
const bluebird = require('bluebird');
const child_process = require('child_process');

const API_VERSION_FILENAME = '.api-version';
const DEFAULT_VERSION = 'unset';

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
  version(): string {
    const version = this.readStaticVersion(); 
    if (version != null) return version; 
    
    return DEFAULT_VERSION;
  }
  
  readStaticVersion(): ?string {
    const searchPaths = process.mainModule.paths; 
      
    for (const current of searchPaths) {
      // Otherwise try to locate '.api-version' as a sibling to the path we found.
      const rootPath = path.dirname(current);
      const versionFilePath = path.join(rootPath, API_VERSION_FILENAME);
      
      // If the version file does not exist, give up. 
      if (! fs.existsSync(versionFilePath)) continue; 
      return fs.readFileSync(versionFilePath).toString();
    }            
    
    // We've searched everything, let's give up.
    return null;
  }
}

module.exports = {
  ProjectVersion
};
