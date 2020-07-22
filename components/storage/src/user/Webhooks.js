const BaseStorage = require('./BaseStorage');
const converters = require('./../converters');
const util = require('util');
const _ = require('lodash');

module.exports = Webhooks;
/**
 * DB persistence for webhooks.
 *
 * @param {Database} database
 * @constructor
 */
function Webhooks(database) {
  Webhooks.super_.call(this, database);

  _.extend(this.converters, {
    itemDefaults: [
      converters.createIdIfMissing,
    ],
    itemToDB: [converters.deletionToDB],
    itemFromDB: [converters.deletionFromDB]
  });

  this.defaultOptions = {
  };
}
util.inherits(Webhooks, BaseStorage);

const indexes = [
  {
    index: { accessId: 1, url: 1 },
    options: {
      unique: true,
      partialFilterExpression: { deleted: { $type: 'null' } }
    }
  }
];

/**
 * Implementation.
 */
Webhooks.prototype.getCollectionInfo = function (user) {
  return {
    name: 'webhooks',
    indexes: indexes,
    useUserId: user.id
  };
};

/**
 * Implementation.
 */
Webhooks.prototype.delete = function (user, query, callback) {
  const update = {
    $set: { deleted: new Date() },
    $unset: {
      accessId: 1,
      url: 1,
      state: 1,
      runCount: 1,
      failCount: 1,
      lastRun: 1,
      runs: 1,
      currentRetries: 1,
      maxRetries: 1,
      minIntervalMs: 1,
      created: 1,
      createdBy: 1,
      modified: 1,
      modifiedBy: 1,
    },
  };
  this.database.updateMany(this.getCollectionInfo(user),
    this.applyQueryToDB(query), update, callback);
};

/**
 * Override base method to set deleted:null
 * 
 * @param {*} user 
 * @param {*} item 
 * @param {*} callback 
 */
Webhooks.prototype.insertOne = function (user, webhook, callback) {
  let webhookToCreate = _.clone(webhook);
  if (webhookToCreate.deleted === undefined) webhookToCreate.deleted = null;
  this.database.insertOne(
    this.getCollectionInfo(user),
    this.applyItemToDB(this.applyItemDefaults(webhookToCreate)),
    function (err) {
      if (err) {
        return callback(err);
      }
      callback(null, _.omit(webhookToCreate, 'deleted'));
    }
  );
};

/**
 * Inserts an array of webhooks; each item must have a valid id and data already. For tests only.
 */
Webhooks.prototype.insertMany = function (user, webhooks, callback) {
  const webhooksToCreate = webhooks.map((w) => {
    if (w.deleted === undefined) return _.assign({ deleted: null }, w);
    return w;
  });
  this.database.insertMany(
    this.getCollectionInfo(user),
    this.applyItemsToDB(webhooksToCreate),
    callback
  );
};