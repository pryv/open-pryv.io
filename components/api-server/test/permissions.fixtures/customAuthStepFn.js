/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
module.exports = function (context, callback) {
  if (context.headers.callerid) { // used for "header tests"
    context.callerId = context.headers.callerid;
  }

  if (context.callerId === 'Please Crash') {
    throw new Error('Crashing as politely asked.');
  } else if (context.callerId !== 'Georges (unparsed)') {
    return callback(new Error('Sorry, only Georges can use the API.'));
  }

  context.callerId = 'Georges (parsed)';
  callback();
};
