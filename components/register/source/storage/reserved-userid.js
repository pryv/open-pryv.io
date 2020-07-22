
const reservedWords = [
  'access',
  'reg',
  'register',
  'service',
  'system'
]

exports.useridIsReserved = function (userid, callback) {
  if (! userid) {
    return null;
  }
  userid = userid.toLowerCase();
  if (/^(pryv)+(.*)$/.test(userid)) {
    return callback(null, true);
  }
  callback(null, reservedWords.includes(userid));
};
