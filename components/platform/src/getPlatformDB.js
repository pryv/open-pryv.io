const { getConfig } = require('@pryv/boiler');
let db;

async function getPlatformDB () {
  if (db != null) return db;
  if ((await getConfig()).get('platform:db') === 'mongodb') {
    const DB = require('./DBmongodb');
    db = new DB();
  } else {
    const DB = require('./DB');
    db = new DB();
  }
  await db.init();
  return db;
}

module.exports = getPlatformDB;
