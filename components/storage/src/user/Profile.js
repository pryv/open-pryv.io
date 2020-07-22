var BaseStorage = require('./BaseStorage'),
    converters = require('./../converters'),
    util = require('util'),
    _ = require('lodash');

module.exports = Profile;
/**
 * DB persistence for profile sets.
 *
 * @param {Database} database
 * @constructor
 */
function Profile(database) {
  Profile.super_.call(this, database);

  _.extend(this.converters, {
    updateToDB: [converters.getKeyValueSetUpdateFn('data')],
    convertIdToItemId: 'profileId'
  });

  this.defaultOptions = {
    sort: {}
  };
}
util.inherits(Profile, BaseStorage);

Profile.prototype.getCollectionInfo = function (user) {
  return {
    name: 'profile',
    indexes: [ {
      index: {profileId: 1},
      options: {unique: true}
    } ],
    useUserId: user.id,
  };
};
