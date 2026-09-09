#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Third-party sign-in link management CLI (operator seam).
//
// A first sign-in through a configured OIDC provider persists a
// `(provider, subject) -> account` binding as a platform unique-field
// row (`sso-<provider>` field, value = the IdP `sub`). This CLI is the
// only management surface for those bindings in the beta: there is no
// user-facing list/unlink endpoint yet. It exists because the first
// binding wins (a later sign-in with the same subject rides the existing
// link), so an account linked to the wrong subject can only be corrected
// by an operator removing the row.
//
// Usage:
//   node bin/sso-link.js list <username>
//   node bin/sso-link.js show <provider> <subject>
//   node bin/sso-link.js unlink <username> <provider> <subject> --yes
//
// Notes:
//   - `list` enumerates the CONFIGURED providers only (a binding for a
//     provider since removed from config is not discoverable this way).
//   - In `platform.piiMode: hashed`, stored subjects are one-way HMAC
//     tokens: `list` cannot show the cleartext subject, but `unlink`
//     still works when the operator supplies the ORIGINAL cleartext
//     subject (from the IdP / support context) — it is hashed internally
//     to match, exactly like every other unique-field write.
//   - `unlink` requires --yes (operator footgun protection).

const path = require('path');

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printUsage(process.stdout);
  process.exit(0);
}

require('@pryv/boiler').init({
  appName: 'sso-link',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../config/plugins/systemStreams')
  }, {
    plugin: require('../config/plugins/core-identity')
  }]
});

const bindingField = (provider) => `sso-${provider}`;

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command == null) {
      printUsage(process.stderr);
      process.exit(1);
    }

    const { config, platform } = await initPlatform();

    switch (args.command) {
      case 'list':
        await runList(config, platform, args);
        break;
      case 'show':
        await runShow(platform, args);
        break;
      case 'unlink':
        await runUnlink(platform, args);
        break;
      default:
        console.error('Unknown command: ' + args.command);
        printUsage(process.stderr);
        process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error: ' + (err.message ?? err));
    if (process.env.DEBUG === '1') console.error(err.stack);
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runList (config, platform, args) {
  const username = args.positional[0];
  if (!username) throw new Error('list: <username> required');
  if (!(await usernameExists(username))) {
    throw new Error('list: user "' + username + '" not found');
  }

  const hashed = (config.get('platform:piiMode') || 'cleartext') === 'hashed';
  const providers = Object.keys(config.get('sso:providers') || {});
  if (providers.length === 0) {
    console.log('No SSO providers are configured (sso:providers is empty).');
    return;
  }

  let total = 0;
  for (const provider of providers) {
    const subjects = await platform.listUserUniqueValues(username, bindingField(provider));
    if (subjects.length === 0) continue;
    total += subjects.length;
    console.log(provider + ':');
    for (const sub of subjects) {
      console.log('  - ' + (hashed ? '(hashed subject; ' + sub.slice(0, 12) + '…)' : sub));
    }
  }
  if (total === 0) {
    console.log('No SSO bindings for "' + username + '" across ' + providers.length + ' configured provider(s).');
  } else if (hashed) {
    console.log();
    console.log('NOTE: piiMode=hashed — subjects shown are HMAC tokens, not the');
    console.log('      cleartext IdP subject. Unlink with the original cleartext');
    console.log('      subject (from the IdP / support context), not the token above.');
  }
}

async function runShow (platform, args) {
  const provider = args.positional[0];
  const subject = args.positional[1];
  if (!provider || !subject) throw new Error('show: <provider> <subject> required');

  const tokenOrName = await platform.getUsersUniqueField(bindingField(provider), subject);
  if (tokenOrName == null) {
    console.log('NOT BOUND: no account is linked to provider "' + provider + '" subject "' + subject + '"');
    process.exit(2);
  }
  const username = await platform.resolveLocalUsernameFromToken(tokenOrName);
  if (username == null) {
    // The row exists but resolves to no local username: a stale binding of a
    // deleted account (hashed mode leaves the token without a live index row).
    console.log('STALE: provider "' + provider + '" subject "' + subject +
      '" is bound, but resolves to no live local account (delete-sweep residue).');
    console.log('       Remove it with: unlink <username> ' + provider + ' ' + subject + ' --yes');
    return;
  }
  console.log('BOUND: provider "' + provider + '" subject "' + subject + '" -> ' + username);
}

async function runUnlink (platform, args) {
  const username = args.positional[0];
  const provider = args.positional[1];
  const subject = args.positional[2];
  if (!username || !provider || !subject) {
    throw new Error('unlink: <username> <provider> <subject> required');
  }
  if (args.flagsScalar.yes !== true) {
    throw new Error('unlink: refusing without --yes (this removes a sign-in binding)');
  }

  const removed = await platform.releaseUserUniqueValue(username, bindingField(provider), subject);
  if (removed) {
    console.log('OK   removed the "' + provider + '" binding for "' + username + '".');
    console.log('     The next sign-in with that subject re-links per the account rules');
    console.log('     (a proved-owned matching email re-creates the binding).');
  } else {
    console.log('NO-OP: no "' + provider + '" binding owned by "' + username +
      '" matched subject "' + subject + '" (already gone, or owned by another account).');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initPlatform () {
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();
  const storages = require('storages');
  await storages.init(config);
  const { getPlatform } = require('platform');
  const platform = await getPlatform();
  return { config, platform };
}

async function usernameExists (username) {
  const { getUsersLocalIndex } = require('storage');
  const usersIndex = await getUsersLocalIndex();
  return await usersIndex.usernameExists(username);
}

function parseArgs (argv) {
  const result = { command: null, positional: [], flags: {}, flagsScalar: {} };
  let i = 0;
  result.command = argv[i++] ?? null;
  while (i < argv.length) {
    const arg = argv[i++];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = (i < argv.length && !argv[i].startsWith('--')) ? argv[i++] : true;
      if (val === true) {
        result.flagsScalar[key] = true;
      } else {
        result.flagsScalar[key] = val;
      }
    } else {
      result.positional.push(arg);
    }
  }
  return result;
}

function printUsage (stream) {
  stream.write(
    'Third-party sign-in (SSO) link management CLI\n\n' +
    'Usage:\n' +
    '  node bin/sso-link.js list <username>\n' +
    '  node bin/sso-link.js show <provider> <subject>\n' +
    '  node bin/sso-link.js unlink <username> <provider> <subject> --yes\n\n' +
    'Notes:\n' +
    '  - list enumerates configured providers only.\n' +
    '  - unlink requires --yes (operator footgun protection).\n' +
    '  - piiMode=hashed hides cleartext subjects in list; unlink still works\n' +
    '    with the original cleartext subject.\n'
  );
}
