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
var fs = require('fs'),
    path = require('path'),
    childProcess = require('child_process');
    
function pad(str) {
  //                total len           - a space - the name
  const targetLen = process.stdout.columns - 1 - str.length; 
  
  return str + ' ' + '-'.repeat(targetLen);
}
    
var colors = false;
try {
  colors = require('colors');
} catch (e) {}

var componentsPath = path.resolve(__dirname, '../dist/components'),
    args = process.argv.slice(2);

if (args.length === 0) {
  console.error('yarn command (like "install") required');
  process.exit(1);
}

var status = 0;
fs.readdirSync(componentsPath).forEach(function (name) {
  var subPath = path.join(componentsPath, name);
  if (! fs.existsSync(path.join(subPath, 'package.json'))) {
    return;
  }
  
  if(['test-helpers', 'errors', 'boiler'].includes(name) && args.slice(1)[0] == 'test'){
    return;
  }
  
  name = pad(name);
  console.log(colors ? name.green : name); // eslint-disable-line 
  var res = childProcess.spawnSync(args[0], args.slice(1), {
    env: process.env,
    cwd: subPath,
    stdio: 'inherit'
  });
  status += res.status;
});

process.exit(status);
