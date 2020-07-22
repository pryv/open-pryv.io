var BaseStorage = require('./BaseStorage'),
    converters = require('./../converters'),
    util = require('util'),
    _ = require('lodash');

module.exports = FollowedSlices;
/**
 * DB persistence for followed slices.
 *
 * @param {Database} database
 * @constructor
 */
function FollowedSlices(database) {
  FollowedSlices.super_.call(this, database);

  _.extend(this.converters, {
    itemDefaults: [converters.createIdIfMissing],
  });

  this.defaultOptions = {
    sort: {name: 1}
  };
}
util.inherits(FollowedSlices, BaseStorage);

var indexes = [
  {
    index: {name: 1},
    options: {unique: true}
  },
  {
    index: { username: 1, accessToken: 1 },
    options: {unique: true}
  }
];

/**
 * Implementation.
 */
FollowedSlices.prototype.getCollectionInfo = function (user) {
  return {
    name: 'followedSlices',
    indexes: indexes,
    useUserId: user.id
  };
};
