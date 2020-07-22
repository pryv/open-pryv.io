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
