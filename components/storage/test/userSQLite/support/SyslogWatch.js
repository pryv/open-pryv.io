/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
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
 */
/**
 * Utility to read syslog
 * For now only tested on OSX
 */
const { spawn } = require('child_process');

function SyslogWatch (stringToMatch) {
  return syslogWatch;

  function syslogWatch (readyCallBack, done) {
    const child = process.platform === 'darwin'
      ? spawn('syslog', ['-w', '0'])
      : spawn('sudo', ['tail', '-f', '/var/log/syslog', '-n', '0']);
    let killed = false;
    let buffer = '';
    let result = null;

    setTimeout(readyCallBack, 1500); // give a chance for syslog to process trailing requests

    setTimeout(notFound, 5000); // close and throw notFound Error

    function notFound () {
      if (killed) return;
      close('Not Found');
    }

    function handleData (from, data) {
      buffer += data;
      const pos = buffer.indexOf(stringToMatch);
      if (pos >= 0) {
        // extract the line for stringToMatch
        let end = buffer.indexOf('\n', pos);
        if (end <= 0) {
          end = buffer.length;
        }
        result = buffer.substring(pos, end);
        close();
      }
    }

    child.stderr.on('data', (data) => {
      handleData('stderr', data);
    });

    child.stdout.on('data', (data) => {
      handleData('stdout', data);
    });

    child.on('exit', function (code, signal) {
      close('child process exited with ' + `code ${code} and signal ${signal}`);
    });

    function close (msg) {
      if (killed) return;
      killed = true;
      try {
        child.kill();
      } catch (e) {
        if (e.code !== 'EPERM') throw e; // EPERM Error might haappend
      }
      if (result) return done(null, result);
      done(new Error(msg));
    }
  }
}
module.exports = SyslogWatch;
