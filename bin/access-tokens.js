#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Access tokens and personal session ids at rest: the core stores a keyed hash
// (the lookup key) and an encrypted copy, never the clear value. This tool
// reports the stored form and runs the two operator passes. Run `unprotect`
// and `rekey` with the core stopped.
//
// Usage:
//   node bin/access-tokens.js status
//   node bin/access-tokens.js rekey --previous-key-file <path>
//   node bin/access-tokens.js unprotect --yes
//
// A core started with `--config <file>` runs this tool with the same
// `--config <file>`, so it reads and writes that core's own storage with its keys.

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

const USAGE = `Usage:
  node bin/access-tokens.js status
  node bin/access-tokens.js rekey --previous-key-file <path>
  node bin/access-tokens.js unprotect --yes

Commands:
  status      Rows per stored form: in clear, protected under the configured key,
              protected under another key (by key id). PostgreSQL also lists the
              access rows in clear (accessesInClear): after a start, the ones the
              conversion left because another live access of the same user holds
              the same token; delete one of the two, the next start converts the
              other. Read-only.
  rekey       Re-hash and re-seal under the configured key the rows protected under
              the previous one, after a change of auth.accessTokensKey or, when that
              is not set, of auth.adminAccessKey. The core refuses to start until
              this is done. The file holds the previous value of the setting that
              was in use (either form is recognised). Idempotent. Core stopped.
  unprotect   Rollback aid, before starting an image that does not protect tokens
              at rest: writes the clear tokens and session ids back and restores the
              clear-token index. Start the previous image right after, without
              starting this image again (its start protects the rows again; the
              tools of this image, status and backup included, leave them in
              clear). Core stopped.

Flags:
  --previous-key-file <path>   (rekey) file holding the previous key value
  --yes                        (unprotect) confirm
  --config <file>              the configuration file the core is started with
                               (as for bin/master.js)
  -h, --help                   print this help
`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// Boiler loads a `--config <file>` itself, above every other scope, as for
// `bin/master.js`; the extra scope below mirrors `bin/integrity-check.js`.
const configFileArg = (() => {
  const i = argv.indexOf('--config');
  return i !== -1 && argv[i + 1] != null ? argv[i + 1] : null;
})();
// Boiler silently skips a missing file: refuse instead of acting on the wrong storage or key.
if (argv.includes('--config') &&
    (configFileArg == null || configFileArg.startsWith('-') ||
     !fs.existsSync(path.resolve(process.cwd(), configFileArg)))) {
  console.error(`--config: file not found: ${configFileArg ?? '(missing <file>)'}`);
  process.exit(1);
}

require('@pryv/boiler').init({
  appName: 'access-tokens',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../config/plugins/systemStreams')
  }, {
    plugin: require('../config/plugins/core-identity')
  }, ...(configFileArg != null
    ? [{ scope: 'host-config', file: path.resolve(process.cwd(), configFileArg) }]
    : [])]
});

(async () => {
  try {
    const args = parseArgs(argv);
    if (args.command == null) {
      process.stderr.write(USAGE);
      process.exit(1);
    }
    let candidates = null;
    if (args.command === 'rekey') {
      if (args.previousKeyFile == null) throw new Error('rekey needs --previous-key-file <path>');
      const { candidateProtectionsFromKeyText } = require('business/src/accesses/tokenProtection.ts');
      candidates = candidateProtectionsFromKeyText(fs.readFileSync(args.previousKeyFile, 'utf8'));
      if (candidates.length === 0) throw new Error('the previous key file is empty');
    }
    if (args.command === 'unprotect' && !args.yes) {
      throw new Error('unprotect writes the clear tokens back into the database: confirm with --yes');
    }

    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const storages = require('storages');
    await storages.init(config);
    const tokensAtRest = storages.getTokensAtRest();

    switch (args.command) {
      case 'status':
        process.stdout.write(yaml.dump(await tokensAtRest.tokensAtRestStatus(), { lineWidth: 200 }));
        break;
      case 'rekey': {
        const res = await tokensAtRest.rekeyTokensAtRest(candidates);
        console.log(`Re-keyed ${res.accesses} access row(s) and ${res.sessions} session(s).`);
        if (res.remaining) {
          console.error('Rows remain under a key other than the configured one (see `status`): ' +
            'the given previous key is not theirs.');
          process.exit(2);
        }
        break;
      }
      case 'unprotect': {
        const res = await tokensAtRest.unprotectTokensAtRest();
        console.log(`Wrote back the clear token of ${res.accesses} access row(s) and the clear id of ${res.sessions} session(s).`);
        console.log('Start the previous image now, without starting this one again.');
        break;
      }
      default:
        process.stderr.write('Unknown command: ' + args.command + '\n' + USAGE);
        process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
})();

function parseArgs (list) {
  const out = { command: null, previousKeyFile: null, yes: false };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--config') i++; // read before boiler init
    else if (a === '--previous-key-file') {
      out.previousKeyFile = list[++i];
      if (out.previousKeyFile == null) throw new Error('--previous-key-file requires a path');
    } else if (!a.startsWith('--') && out.command == null) out.command = a;
    else throw new Error('Unknown argument: ' + a);
  }
  return out;
}
