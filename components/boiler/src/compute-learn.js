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
/**
 * read all files in CONFIG_LEARN_DIR and output a readable result
 */

const path = require('path');
const learnDir = process.env.CONFIG_LEARN_DIR || path.resolve(__dirname, '../../../learn-config');
console.log('Looking for learning files in: ' + learnDir);
const fs = require('fs');

const apps = {};
const ranking = {};

// get all files
const files = fs.readdirSync(learnDir);

for (const file of files) {
  if (file.endsWith('-calls.csv')) {
    handleCSV(path.join(learnDir, file));
  }
}

for (const file of files) {
  if (file.endsWith('-config.json')) {
    handleConfig(path.join(learnDir, file));
  }
}

function handleConfig(file) {
  const appNameSearch = /.*\/([a-zA-Z\-]*)[0-9]{1,2}-config.json/;
  const appName = file.match(appNameSearch)[1];
  const config = require(file).config;
  const calls = apps[appName].calls;

  checkExistsAndFlag(config, calls);

  function checkExistsAndFlagX(configItem, path) { 
    console.log(path);
    
    for (let key of Object.keys(configItem)) {
      checkExistsAndFlag(configItem[key], path + ':' + key);
    }
  }

  function checkExistsAndFlag(configItem, callsItem) {
    if (typeof configItem !== 'object' || Array.isArray(configItem)) return;
    for (let key of Object.keys(configItem)) {
      if (key !== 'calls') {
        if (typeof callsItem[key] === 'undefined') {
          callsItem[key] = 'UNUSED';
          //console.log(callsItem)
        } else {
          checkExistsAndFlag(configItem[key], callsItem[key]);
        }
      }
    }
  }
}


function handleCSV(file) {
  const appNameSearch = /.*\/([a-zA-Z\-]*)[0-9]{1,2}-calls.csv/;
  const appName = file.match(appNameSearch)[1];
  
  // initialize apps.appname if needed
  if (! apps[appName]) {
    apps[appName] = {
      calls: {},
      rank: {}
    }
  }

  
  const filelines = fs.readFileSync(file, 'utf-8').split('\n');
  for (let line of filelines) {
    // -- calls count
    const [path, call] = line.split(';');
    const key = deepFind(apps[appName].calls, path + ':calls');
    if (! key[call]) key[call] = 0;
    key[call]++;
    // -- ranking
    apps[appName].rank[line] = key[call];
  }
}

function deepFind(obj, path) {
  var paths = path.split(':')
    , current = obj
    , i;

  for (i = 0; i < paths.length; ++i) {
    if (current[paths[i]] == undefined) {
      current[paths[i]] = {}; // initialize path while searching
    }
    current = current[paths[i]];
  }
  return current;
}


// sort and filter ranking
const KEEP_HIGHER_N = 10;

for (let appName of Object.keys(apps)) {
  const app = apps[appName];
  const arrayOfCalls = [];
  for (let callLine of Object.keys(app.rank)) {
    arrayOfCalls.push({count: app.rank[callLine], line: callLine});
   
  }
  const arrayOfCallsSorted = arrayOfCalls.sort((a, b) => { return b.count - a.count});
  // replace rank info
  app.rank =  arrayOfCallsSorted.slice(0, KEEP_HIGHER_N);
}

fs.writeFileSync(path.join(learnDir, 'compute.json'), JSON.stringify(apps, null, 2));
//console.log(apps);