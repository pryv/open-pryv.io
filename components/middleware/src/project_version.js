// @flow

// Retrieves the projects version from git and from our deploy process. 

const path = require('path');
const fs = require('fs');
const bluebird = require('bluebird');
const child_process = require('child_process');

const API_VERSION_FILENAME = '.api-version';

// The method '#version' returns a version string for this project; it
// determines it using one of two methods: 
// 
//   a) If the project contains a file called '.api-version' at its root, 
//      the contents of the file are returned as version string. Take care 
//      to strip newlines from the file. 
//   b) Otherwise, we try to run 'git describe' and use the output from this
//      command. 
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
  async version(): Promise<string> {
    const version = this.readStaticVersion(); 
    if (version != null) return version; 
    
    // NOTE If we get here, we better be in a development environment. Otherwise
    // we will try to run git describe and fail, throwing an error in the 
    // process. 
    
    return await this.gitVersion(); 
  }
  
  async gitVersion(): Promise<string> {
    const version = await this.exec('git describe');
    
    return version.slice(0, -1);
  }
  
  async exec(cmd: string): Promise<string> {
    const exec = (cmd) => bluebird.fromCallback(
      cb => child_process.exec(cmd, cb));

    return exec(cmd);
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
