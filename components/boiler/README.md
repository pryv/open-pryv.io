# Pryv config and logging boilerplate for Node.js


## Usage


### Initialization

The "boiler" must be initialized with the application name and configuration files settings, before invoking `getConfig()` or `getLogger()`:

```js
require('@pryv/boiler').init({
  appName: 'my-app', // This will will be prefixed to any log messages
  baseFilesDir: path.resolve(__dirname, '..'), // use for file:// relative path if not give cwd() will be used
  baseConfigDir: path.resolve(__dirname, '../config'),
  extraConfigs: [{
    scope: 'extra-config',
    file: path.resolve(__dirname, '../config/extras.js')
  }]
});
```


### Configuration

We use [nconf](https://www.npmjs.com/package/nconf).

#### Base config directory structure

During initialization `default-config.yml` and `${NODE_ENV}-config.yml` will be loaded if present in `baseConfigDir`.

#### Loading order and precedence

The order configuration sources are loaded is important. Each source is loaded with a "scope" name, which can be used to replace the source's contents at any point of time.

The configuration sources are loaded in the following order, the first taking precedence:

1. **'test'**: Empty slot reserved for tests to override any other config parameter
2. **'argv'**: Command line arguments
3. **'env'**: Environment variables
4. **'base'**: File `${NODE_ENV}-config.yml` (if present) or specified by the `--config` command line argument
5. **'extra-config'**: Additional source(s) as specified by the `extraConfigs` option (see below)
6. Defaults:
   - **'default-file'**: `${baseConfigDir}/default-config.yml`
   - **'defaults'**: Hard-coded defaults for logger

#### Extra configurations

Additional configuration sources can be set or reserved at initialization with the `extraConfigs` option, which expects an array of objects with one of the following structures:

- File: `{scope: <name>, file: <path to file> }`. Accepts `.yml`, `.json` and `.js` files. Note `.js` content is loaded with `require(<path to file>)`.
- Data: `{scope: <name>, key: <optional key>, data: <object> }`. If `key` is provided, the content of `data` will be accessible by this key, otherwise it is loaded at the root of the configuration.
- Remote URL: `{scope: <name>, key: <optional key>, url: <URL to json content> }`. The JSON contents of this URL will be loaded asynchronously.
- URL from key: `{scope: <name>, key: <optional key>, urlFromKey: <key> }`. Similar to remove URL, with the URL obtained from an existing configuration key.

#### Working with the configuration

Retrieving the configuration object:

```javascript
// synchronous loading
const { getConfigUnsafe } = require('@pryv/boiler'); // Until all asynchronous sources such as URL are loaded, items might not be available
const config = await getConfigUnsafe();

// asynchronous loading
const { getConfig } = require('@pryv/boiler');
const config = await getConfig(); // Here we can be sure all items are fully loaded
```

Retrieving settings:

```javascript
// configuration content is {foo: { bar: 'hello'}};
const foo = config.get('foo'); // {bar: 'hello'}
const bar = config.get('foo:bar'); // 'hello'

const barExists = config.has('bar'); // true
```

Assigning settings:

```javascript
// configuration content is {foo: { bar: 'hello'}};
config.set('foo', 'bye bye'); // {bar: 'hello'}
const foo = config.get('foo'); // 'bye bye'
```

Changing a scope's contents:

```javascript
// configuration content is {foo: { bar: 'hello'}};
config.get('foo'); // {bar: 'hello'}
// replace 'test' existing content (test is always present as the topmost configuration source)
config.replaceScopeConfig('test', {foo: 'test'});
config.get('foo'); // 'test'
// reset content of 'test' scope
config.replaceScopeConfig('test', {});
config.get('foo'); // {bar: 'hello'}

// Note: for 'test' scope there is a "sugar" function with config.injectTestConfig(object)
```

Finding out from which scope a key applies:
As nconf is hierachical sometimes you migth want to search from which scope the value of a key is issued.

```javascript
config.getScopeAndValue('foo'); 
// returns {value: 'bar', scope: 'scopeName'; info: 'From <file> or Type <env, '}
```

#### "Learn" mode

To help detect unused configuration settings, a "learn" mode can be activated to track all calls to `config.get()` in files.

Example when running tests:
```
export CONFIG_LEARN_DIR="{absolute path}/service-core/learn-config"
yarn test
```
Note, if CONFIG_LEARN_DIR is not given `{process.cwd()}/learn-config` will be used 

### Logging

All messages are prefixed by the `appName` value provided at initialization (see above)). `appName` can be postfixed with a string by setting the environment variable `PRYV_BOILER_SUFFIX`, which is useful when spawning several concurrent processes of the same application.

#### Using the logger

```javascript
const {getLogger} = require('@pryv/boiler');

logger.info('Message', item); // standard log
logger.warn('Message', item); // warning
logger.error('Message', item); // warning
logger.debug('Message', item); // debug

logger.getLogger('sub'); // new logger name spaced with parent, here '{appName}:sub'
```

`logger.info()`, `logger.warn()` and `logger.error()` use [Winston](https://www.npmjs.com/package/winston) `logger.debug()` is based on [debug](https://www.npmjs.com/package/debug).

#### Outputting debug messages

Set the `DEBUG` environment variable. For example: `DEBUG="*" node app.js` will output all debug messages.

As "debug" is a widely used package, you might get way more debug lines than expected, so you can use the `appName` property to only output messages from your application code: `DEBUG="<appName>*" node app.js`

#### Using a custom logger

A custom logger can be used by providing `logs:custom` information to the configuration. A working sample of custom Logger is provided in `./examples/customLogger`. 

The module must implement `async init(settings)` and `log(level, key, message, meta)`

#### Log configuration sample

```javascript
logs: {
    console: {
      active: true,
      level: 'info',
      format: {
        color: true,
        time: true,
        aligned: true
      }
    },
    file: {
      active: true,
      path: 'application.log'
    },
    custom: { 
      active: true,
      path 'path/to/node/package',
      settings: { /* settings passed to the custom logger */}
    }
  }
```

## TODO

- Make config an eventEmitter ? // to track when read or if config changes
- FIX realtive PATH logic for config.loadFromFile() 


## Contributing

`npm run lint` lints the code with [Semi-Standard](https://github.com/standard/semistandard).

`npm run license` updates license information.


## License

[BSD-3-Clause](https://github.com/pryv/pryv-boiler/blob/master/LICENSE)
