/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-boiler/blob/master/LICENSE)
 */
/**
 * read all files in CONFIG_LEARN_DIR and output a readable result
 */

const path = require('path');
const learnDir = process.env.CONFIG_LEARN_DIR || path.resolve(process.cwd(), 'learn-config');
console.log('Looking for learning files in: ' + learnDir);
const fs = require('fs');

const apps = {};

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

function handleConfig (file) {
  /* eslint-disable-next-line no-useless-escape */
  const appNameSearch = /.*\/([a-zA-Z\-]*)[0-9]{1,2}-config.json/;
  const appName = file.match(appNameSearch)[1];
  const config = require(file).config;
  const calls = apps[appName].calls;

  checkExistsAndFlag(config, calls);

  function checkExistsAndFlag (configItem, callsItem) {
    if (typeof configItem !== 'object' || Array.isArray(configItem)) return;
    for (const key of Object.keys(configItem)) {
      if (key !== 'calls') {
        if (typeof callsItem[key] === 'undefined') {
          callsItem[key] = 'UNUSED';
          // console.log(callsItem)
        } else {
          checkExistsAndFlag(configItem[key], callsItem[key]);
        }
      }
    }
  }
}

function handleCSV (file) {
  /* eslint-disable-next-line no-useless-escape */
  const appNameSearch = /.*\/([a-zA-Z\-]*)[0-9]{1,2}-calls.csv/;
  const appName = file.match(appNameSearch)[1];

  // initialize apps.appname if needed
  if (!apps[appName]) {
    apps[appName] = {
      calls: {},
      rank: {}
    };
  }

  const filelines = fs.readFileSync(file, 'utf-8').split('\n');
  for (const line of filelines) {
    // -- calls count
    const [path, call] = line.split(';');
    const key = deepFind(apps[appName].calls, path + ':calls');
    if (!key[call]) key[call] = 0;
    key[call]++;
    // -- ranking
    apps[appName].rank[line] = key[call];
  }
}

function deepFind (obj, path) {
  const paths = path.split(':');
  let current = obj;
  let i;

  for (i = 0; i < paths.length; ++i) {
    if (current[paths[i]] === undefined) {
      current[paths[i]] = {}; // initialize path while searching
    }
    current = current[paths[i]];
  }
  return current;
}

// sort and filter ranking
const KEEP_HIGHER_N = 10;

for (const appName of Object.keys(apps)) {
  const app = apps[appName];
  const arrayOfCalls = [];
  for (const callLine of Object.keys(app.rank)) {
    arrayOfCalls.push({ count: app.rank[callLine], line: callLine });
  }
  const arrayOfCallsSorted = arrayOfCalls.sort((a, b) => { return b.count - a.count; });
  // replace rank info
  app.rank = arrayOfCallsSorted.slice(0, KEEP_HIGHER_N);
}

fs.writeFileSync(path.join(learnDir, 'compute.json'), JSON.stringify(apps, null, 2));
// console.log(apps);
