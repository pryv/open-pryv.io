/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
