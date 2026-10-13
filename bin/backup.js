#!/usr/bin/env node

/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Standalone CLI for backup and restore operations.
//
// Backup:
//   node bin/backup.js --output /path/to/backup
//   node bin/backup.js --output /path/to/backup --user userId123
//   node bin/backup.js --output /path/to/backup --no-compress
//   node bin/backup.js --output /path/to/backup --incremental
//   node bin/backup.js --output /path/to/backup --max-chunk-size 50
//   node bin/backup.js --output /path/to/backup --include-ephemeral
//   node bin/backup.js --output /path/to/backup --recipient-pubkey recipient.pub.pem
//   node bin/backup.js --output /path/to/backup --passphrase-file /root/backup-passphrase
//
// Restore:
//   node bin/backup.js --restore /path/to/backup
//   node bin/backup.js --restore /path/to/backup --overwrite
//   node bin/backup.js --restore /path/to/backup --user userId123
//   node bin/backup.js --restore /path/to/backup --skip-conflicts --move-on-success /path/to/done
//   node bin/backup.js --restore /path/to/backup --skip-conflicts --delete-on-success
//   node bin/backup.js --restore /path/to/backup --private-key recipient.key.pem
//   node bin/backup.js --restore /path/to/backup --passphrase-file /root/backup-passphrase
//   node bin/backup.js --restore /path/to/backup --require-encrypted --private-key recipient.key.pem
//   node bin/backup.js --restore /path/to/backup --through-run 20261013T142501Z-3f9a1c7e
//
// Inspect (no storage access):
//   node bin/backup.js --inspect /path/to/backup
//
// A full backup and the incremental runs written after it into the same
// directory form a chain: each incremental run has its own
// `incrementals/<runId>/` directory, `chain.json` lists the runs, and
// `--restore` applies them in order.

const path = require('path');
const fs = require('fs');

// Initialize boiler (same config plugins as api-server, minus express/routes)
require('@pryv/boiler').init({
  appName: 'backup',
  baseFilesDir: path.resolve(__dirname, '../'),
  baseConfigDir: path.resolve(__dirname, '../config/'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, '../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../config/plugins/systemStreams')
  }, {
    scope: 'default-audit-path',
    file: path.resolve(__dirname, '../config/plugins/default-path.js')
  }, {
    plugin: require('../config/plugins/core-identity')
  }]
});

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printUsage();
      process.exit(0);
    }

    // Inspect a backup directory: reads files only, no storage.
    if (args.inspect) {
      process.exit(runInspect(args));
    }

    // Refuse an unexpected plaintext backup before touching any storage.
    if (args.restore) checkRestoreEncryption(args);
    if (args.output && !args.restore) warnIfPlaintextBackup(args);

    // Initialize storage subsystems
    await initStorage();

    let exitCode = 0;
    if (args.restore) {
      exitCode = await runRestore(args);
    } else if (args.output) {
      await runBackup(args);
    } else {
      console.error('Error: --output or --restore is required');
      printUsage();
      process.exit(1);
    }

    process.exit(exitCode);
  } catch (err) {
    console.error('Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function initStorage () {
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();

  const userLocalDirectory = require('storage').userLocalDirectory;
  await userLocalDirectory.init();

  await require('storages').init(config);

  // Init audit if active
  if (config.get('audit:active')) {
    const audit = require('audit').default;
    await audit.init();
  }

  console.log('Storage initialized');
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

async function runBackup (args) {
  const { createFilesystemBackupWriter, planBackupRun } = require('storages/interfaces/backup/index.ts');
  const BackupOrchestrator = require('business/src/backup/BackupOrchestrator.ts').default;

  // What this run writes, and every refusal (backup already there, damaged
  // directory, another key model, wrong passphrase, other recipient key),
  // decided before anything is written.
  const passphrase = args.encryptPassphrase || process.env.PRYV_BACKUP_PASSPHRASE || null;
  const plan = planBackupRun(args.output, {
    incremental: args.incremental,
    passphrase,
    recipientPubKeyPem: args.recipientPubkey ? fs.readFileSync(args.recipientPubkey, 'utf8') : null,
    privateKeyPem: args.privateKey ? fs.readFileSync(args.privateKey, 'utf8') : null,
    privateKeyPassphrase: args.privateKeyPassphrase || process.env.PRYV_BACKUP_PRIVATE_KEY_PASSPHRASE || null
  });
  if (plan.strays.length > 0) {
    console.warn(`WARNING: ignored, not listed by chain.json (an interrupted run?): ${plan.strays.join(', ')}`);
  }
  if (plan.isIncremental) {
    console.log(`Incremental backup: run ${plan.runId} of the chain at ${args.output} (after run ${plan.parentRunId})`);
  } else if (args.incremental) {
    console.log('No previous backup found — running full backup instead');
  }

  // A fresh data key (hybrid) or a fresh salt (symmetric) for every run.
  const encryptor = buildEncryptor(args);
  if (encryptor) {
    console.log(`Encryption: ${encryptor.envelope.mode} (${encryptor.envelope.alg}) — destination bytes are ciphertext only`);
  }

  const writer = createFilesystemBackupWriter(args.output, {
    maxChunkSize: (args.maxChunkSize || 50) * 1024 * 1024,
    compress: args.compress,
    encryptor,
    run: plan
  });

  const orchestrator = new BackupOrchestrator();
  await orchestrator.init();

  const options = {
    includeEphemeral: args.includeEphemeral,
    chain: plan.baseChain
  };

  if (args.user) {
    console.log(`Backing up user: ${args.user}`);
    await orchestrator.backupUser(args.user, writer, options);
  } else {
    console.log('Backing up all users');
    await orchestrator.backupAllUsers(writer, options);
  }

  await writer.close();
  console.log(`Backup written to: ${args.output}`);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * A plaintext backup (no `encryption.json`) is not read as such when the operator
 * supplied a decryption secret, or asked for an encrypted backup: whoever can
 * write to the backup destination could otherwise replace an encrypted backup by
 * plaintext files and have them restored silently. `--allow-plaintext` lifts
 * the refusal explicitly.
 */
function checkRestoreEncryption (args) {
  if (args.allowPlaintext) return;
  if (fs.existsSync(path.join(args.restore, 'encryption.json'))) return;
  const secretSupplied = !!(args.decryptPassphrase || args.encryptPassphrase ||
    process.env.PRYV_BACKUP_PASSPHRASE || args.privateKey);
  if (!secretSupplied && !args.requireEncrypted) return;
  const reason = args.requireEncrypted ? '--require-encrypted was given' : 'a decryption secret was supplied';
  throw new Error(
    `${reason} but the backup at ${args.restore} is not encrypted (no encryption.json). ` +
    'Refusing to restore it as plaintext; pass --allow-plaintext to restore it anyway.'
  );
}

/**
 * A backup holds every account's data (events, accesses with their tokens,
 * webhooks, audit). Without a key model it is written as plaintext: say so on
 * every run, where cron mails and CI logs will show it.
 */
function warnIfPlaintextBackup (args) {
  if (args.recipientPubkey || args.encryptPassphrase || process.env.PRYV_BACKUP_PASSPHRASE) return;
  console.error('WARNING: this backup is NOT encrypted: it holds every account\'s data (events, accesses and their tokens, webhooks, audit) in plaintext. ' +
    'Pass --recipient-pubkey <pem> (recommended) or --passphrase-file <path> to encrypt it.');
}

async function runRestore (args) {
  const { createFilesystemBackupReader } = require('storages/interfaces/backup/index.ts');
  const RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator.ts').default;

  // Encrypted backups carry a cleartext `encryption.json` envelope at the root
  // (and one per incremental run of a chain).
  const encryptionPath = path.join(args.restore, 'encryption.json');
  if (fs.existsSync(encryptionPath)) {
    // Not followed when it is a symbolic link, like every other file of the backup.
    let envelopeText;
    try {
      envelopeText = fs.readFileSync(encryptionPath, { encoding: 'utf8', flag: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) });
    } catch (err) {
      if (err.code === 'ELOOP') throw new Error(`Backup file ${encryptionPath} is a symbolic link: refused`);
      throw err;
    }
    const envelope = JSON.parse(envelopeText);
    console.log(`Encrypted backup detected: ${envelope.mode} (${envelope.alg})`);
  }

  // The reader resolves the chain (every run, each decrypted with its own
  // envelope and the secret) and presents one merged backup.
  const reader = createFilesystemBackupReader(args.restore, {
    secrets: buildDecryptSecrets(args),
    throughRun: args.throughRun,
    allowIncomplete: args.allowIncomplete,
    onWarning: (message) => console.warn('WARNING: ' + message)
  });

  const orchestrator = new RestoreOrchestrator();
  await orchestrator.init();

  const options = {
    overwrite: args.overwrite,
    skipConflicts: args.skipConflicts,
    deleteOnSuccess: args.deleteOnSuccess,
    moveOnSuccess: args.moveOnSuccess
  };

  let report;
  if (args.user) {
    console.log(`Restoring user: ${args.user}`);
    report = await orchestrator.restoreUser(args.user, reader, options);
  } else {
    console.log('Restoring all users');
    report = await orchestrator.restoreAllUsers(reader, options);
  }

  await reader.close();

  // Exit code from the verification step (0 = ok / not requested, 1 = a failure was
  // rolled back, 2 = restored but could not be verified). Returned to the caller.
  let verifyExitCode = 0;

  // Post-restore integrity verification
  if (args.verifyIntegrity && report.restored.length > 0) {
    console.log('\nVerifying integrity of restored data...');
    const IntegrityCheck = require('business/src/integrity/IntegrityCheck.ts').default;
    const checker = new IntegrityCheck();
    await checker.init();

    const failedUsers = [];
    const unverifiedUsers = [];
    for (const { userId, username } of report.restored) {
      const intReport = await checker.checkUser(userId);
      const errorCount = intReport.events.errors.length + intReport.accesses.errors.length;
      if (!intReport.ok) {
        console.log(`  [FAIL] ${username} — ${errorCount} integrity error(s)`);
        for (const err of intReport.events.errors.slice(0, 3)) {
          console.log(`    Event ${err.eventId}: ${err.error}`);
        }
        for (const err of intReport.accesses.errors.slice(0, 3)) {
          console.log(`    Access ${err.accessId}: ${err.error}`);
        }
        failedUsers.push({ userId, username, intReport });
      } else if (!intReport.verified) {
        // No errors, but at least one store was not actually checked (integrity
        // inactive or store unavailable). A restore that verified nothing must
        // NOT read as [OK].
        console.log(`  [NOT VERIFIED] ${username} — events=${storeCheckDetail(intReport.events)} accesses=${storeCheckDetail(intReport.accesses)}`);
        unverifiedUsers.push({ userId, username, intReport });
      } else {
        console.log(`  [OK] ${username} — events=${intReport.events.checked} accesses=${intReport.accesses.checked}`);
      }
    }

    if (failedUsers.length > 0) {
      console.log(`\nIntegrity check failed for ${failedUsers.length} user(s). Rolling back...`);
      for (const { userId, username } of failedUsers) {
        try {
          await orchestrator._clearUserData({ id: userId }, userId);
          console.log(`  Rolled back: ${username} (${userId})`);
        } catch (e) {
          console.error(`  Rollback failed for ${username}: ${e.message}`);
        }
      }
      // Remove failed users from restored list and add to report
      report.rolledBack = failedUsers.map(f => ({ userId: f.userId, username: f.username }));
      report.restored = report.restored.filter(u =>
        !failedUsers.some(f => f.userId === u.userId)
      );
      console.log('\nRollback complete. Only users that passed integrity checks remain.');
    }

    if (unverifiedUsers.length > 0) {
      // Loud, unmissable: this restore was NOT verified. Not rolled back
      // (rollback is for proven corruption, not for absence of proof).
      console.log(`\nWARNING: ${unverifiedUsers.length} user(s) were NOT verified — restored data could not be`);
      console.log('  confirmed (integrity inactive or store unavailable). This restore did NOT earn [OK]:');
      for (const { username, userId } of unverifiedUsers) {
        console.log(`    - ${username} (${userId})`);
      }
      report.unverified = unverifiedUsers.map(u => ({ userId: u.userId, username: u.username }));
    }

    // Precedence: any failure trumps; else any unverified user.
    if (failedUsers.length > 0) verifyExitCode = 1;
    else if (unverifiedUsers.length > 0) verifyExitCode = 2;
  }

  // Post-restore cleanup — when integrity verification was requested, only clean up
  // the backup source on a fully green result (nothing failed AND nothing unverified);
  // otherwise keep it, since for rolled-back or unverified users the backup may be the
  // only remaining copy. Without --verify-integrity, behaviour is unchanged.
  const verifyIncomplete = args.verifyIntegrity && verifyExitCode !== 0;
  if (report.restored.length > 0 && !verifyIncomplete) {
    if (args.deleteOnSuccess) {
      fs.rmSync(args.restore, { recursive: true, force: true });
      console.log(`Backup deleted: ${args.restore}`);
    } else if (args.moveOnSuccess) {
      fs.mkdirSync(path.dirname(args.moveOnSuccess), { recursive: true });
      fs.renameSync(args.restore, args.moveOnSuccess);
      console.log(`Backup moved to: ${args.moveOnSuccess}`);
    }
  } else if (verifyIncomplete && (args.deleteOnSuccess || args.moveOnSuccess)) {
    console.log('Backup kept: integrity verification incomplete or failed.');
  }

  // Print report
  console.log('\nRestore report:');
  console.log(`  Restored: ${report.restored.length} users`);
  for (const u of report.restored) {
    console.log(`    - ${u.username} (${u.userId})`);
  }
  if (report.skipped.length > 0) {
    console.log(`  Skipped: ${report.skipped.length} users`);
    for (const u of report.skipped) {
      console.log(`    - ${u.username} (${u.userId})`);
    }
  }
  if (report.conflicts.length > 0) {
    console.log(`  Conflicts: ${report.conflicts.length}`);
    for (const c of report.conflicts) {
      console.log(`    - ${c.username}: ${c.reason}`);
    }
  }
  if (report.rolledBack && report.rolledBack.length > 0) {
    console.log(`  Rolled back (integrity failure): ${report.rolledBack.length} users`);
    for (const u of report.rolledBack) {
      console.log(`    - ${u.username} (${u.userId})`);
    }
  }
  if (report.unverified && report.unverified.length > 0) {
    console.log(`  Not verified (integrity inactive or store unavailable): ${report.unverified.length} users`);
    for (const u of report.unverified) {
      console.log(`    - ${u.username} (${u.userId})`);
    }
  }

  return verifyExitCode;
}

/**
 * Human-readable per-store detail for a verification report line: the checked
 * count when the store was actually verified, or why it was not.
 */
function storeCheckDetail (store) {
  if (store.status === 'checked') return String(store.checked);
  if (store.status === 'inactive') return 'not verified (integrity inactive)';
  return 'not verified (store unavailable)';
}

// ---------------------------------------------------------------------------
// Encryption key resolution
// ---------------------------------------------------------------------------

/**
 * Build an encryptor from the backup-side flags, or null when no encryption
 * option was given (preserving the default plaintext behaviour). The hybrid
 * model (--recipient-pubkey) is recommended: the backup host holds no secret
 * that can decrypt its own output. The passphrase may also come from the
 * PRYV_BACKUP_PASSPHRASE env var so it doesn't appear in the process list.
 */
function buildEncryptor (args) {
  const { createBackupEncryptor } = require('storages/interfaces/backup/index.ts');
  const passphrase = args.encryptPassphrase || process.env.PRYV_BACKUP_PASSPHRASE;
  if (args.recipientPubkey) {
    return createBackupEncryptor({ recipientPubKeyPem: fs.readFileSync(args.recipientPubkey, 'utf8') });
  }
  if (passphrase) {
    return createBackupEncryptor({ passphrase });
  }
  return null;
}

/** Build the secrets needed to decrypt an encrypted backup (restore or inspect). */
function buildDecryptSecrets (args) {
  const passphrase = args.decryptPassphrase || args.encryptPassphrase || process.env.PRYV_BACKUP_PASSPHRASE;
  const secrets = { passphrase };
  if (args.privateKey) {
    secrets.privateKeyPem = fs.readFileSync(args.privateKey, 'utf8');
    secrets.privateKeyPassphrase = args.privateKeyPassphrase || process.env.PRYV_BACKUP_PRIVATE_KEY_PASSPHRASE;
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

/**
 * Print what a backup directory holds (the runs of its chain, or the one run
 * of a full backup written before chains) and one verdict. Exit code: 0 OK,
 * 1 DAMAGED / INCOMPLETE / INVALID, 2 UNKNOWN (the secret is needed).
 */
function runInspect (args) {
  const { inspectBackup } = require('storages/interfaces/backup/index.ts');
  const report = inspectBackup(args.inspect, { secrets: buildDecryptSecrets(args) });
  for (const line of report.lines) console.log(line);
  console.log(report.verdict);
  if (report.status === 'ok') return 0;
  if (report.status === 'unknown') return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const args = {
    output: null,
    restore: null,
    user: null,
    compress: true,
    maxChunkSize: 50,
    includeEphemeral: false,
    incremental: false,
    overwrite: false,
    skipConflicts: false,
    deleteOnSuccess: false,
    moveOnSuccess: null,
    verifyIntegrity: false,
    encryptPassphrase: null,
    recipientPubkey: null,
    decryptPassphrase: null,
    privateKey: null,
    privateKeyPassphrase: null,
    passphraseFile: null,
    allowPlaintext: false,
    requireEncrypted: false,
    throughRun: null,
    allowIncomplete: false,
    inspect: null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--output':
      case '-o':
        args.output = argv[++i];
        break;
      case '--restore':
      case '-r':
        args.restore = argv[++i];
        break;
      case '--user':
      case '-u':
        args.user = argv[++i];
        break;
      case '--no-compress':
        args.compress = false;
        break;
      case '--max-chunk-size':
      case '--target-file-size':
        args.maxChunkSize = parseInt(argv[++i], 10);
        break;
      case '--include-ephemeral':
        args.includeEphemeral = true;
        break;
      case '--incremental':
        args.incremental = true;
        break;
      case '--overwrite':
        args.overwrite = true;
        break;
      case '--skip-conflicts':
        args.skipConflicts = true;
        break;
      case '--delete-on-success':
        args.deleteOnSuccess = true;
        break;
      case '--move-on-success':
        args.moveOnSuccess = argv[++i];
        break;
      case '--verify-integrity':
        args.verifyIntegrity = true;
        break;
      case '--encrypt-passphrase':
        args.encryptPassphrase = argv[++i];
        break;
      case '--recipient-pubkey':
        args.recipientPubkey = argv[++i];
        break;
      case '--decrypt-passphrase':
        args.decryptPassphrase = argv[++i];
        break;
      case '--private-key':
        args.privateKey = argv[++i];
        break;
      case '--private-key-passphrase':
        args.privateKeyPassphrase = argv[++i];
        break;
      case '--passphrase-file':
        args.passphraseFile = argv[++i];
        break;
      case '--allow-plaintext':
        args.allowPlaintext = true;
        break;
      case '--require-encrypted':
        args.requireEncrypted = true;
        break;
      case '--through-run':
        args.throughRun = argv[++i];
        break;
      case '--allow-incomplete':
        args.allowIncomplete = true;
        break;
      case '--inspect':
        args.inspect = argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        args.help = true;
    }
  }

  // Validate
  if (args.deleteOnSuccess && args.moveOnSuccess) {
    console.error('Error: --delete-on-success and --move-on-success are mutually exclusive');
    process.exit(1);
  }
  // --passphrase-file: the passphrase read from a file (first line), so it
  // appears neither in the process list nor in the shell history. It is the
  // encryption passphrase of a backup, the decryption one of a restore.
  if (args.passphraseFile != null) {
    if (args.encryptPassphrase || args.decryptPassphrase) {
      console.error('Error: --passphrase-file and --encrypt-passphrase / --decrypt-passphrase are mutually exclusive');
      process.exit(1);
    }
    let passphrase;
    try {
      passphrase = fs.readFileSync(args.passphraseFile, 'utf8').split(/\r?\n/)[0];
    } catch (err) {
      console.error(`Error: cannot read --passphrase-file ${args.passphraseFile}: ${err.message}`);
      process.exit(1);
    }
    if (!passphrase) {
      console.error(`Error: --passphrase-file ${args.passphraseFile} is empty`);
      process.exit(1);
    }
    if (args.restore || args.inspect) args.decryptPassphrase = passphrase; else args.encryptPassphrase = passphrase;
  }
  if (args.recipientPubkey && args.encryptPassphrase) {
    console.error('Error: --recipient-pubkey and --encrypt-passphrase are mutually exclusive (pick one key model)');
    process.exit(1);
  }
  if (args.allowPlaintext && args.requireEncrypted) {
    console.error('Error: --allow-plaintext and --require-encrypted are mutually exclusive');
    process.exit(1);
  }

  return args;
}

function printUsage () {
  console.log(`
Usage: node bin/backup.js [options]

Backup:
  --output, -o <path>       Output directory for backup
  --user, -u <userId>       Backup a single user (default: all users)
  --no-compress             Disable gzip compression (for debugging)
  --max-chunk-size <MB>     Target chunk size in MB of raw (pre-gzip) data (default: 50)
  --include-ephemeral       Include sessions and password-reset-requests
  --incremental             Into an existing backup directory: export only what
                            changed since the previous run (per user), as a new
                            run of the directory's chain: its own
                            incrementals/<runId>/ directory, listed by
                            chain.json. Earlier runs are never rewritten. Use the
                            same key model as the full backup (same passphrase,
                            or same recipient public key: the private key is not
                            needed, except once for a hybrid full backup written
                            before 2.0.0-rc.51).

Encryption (opt-in — without these flags output is plaintext, with a warning):
  --recipient-pubkey <pem>  Encrypt output with a recipient RSA public key
                            (recommended): the backup host holds no decrypt
                            secret — only the private-key holder can restore.
  --passphrase-file <path>  Encrypt output with the passphrase on the first line
                            of this file (scrypt-derived). Simpler than a key
                            pair, but this host can decrypt its own backup.
  --encrypt-passphrase <s>  Same, the passphrase given on the command line (it
                            then shows in the process list and the shell
                            history: prefer --passphrase-file).
                            Also read from PRYV_BACKUP_PASSPHRASE if omitted.

Restore:
  --restore, -r <path>      Restore from backup directory (a chain: the full
                            backup, then every incremental run in order; a newer
                            version of an item replaces the older one)
  --through-run <runId>     Apply the chain up to this run only (the state as of
                            that run; see --inspect for the run ids)
  --allow-incomplete        Restore a directory damaged by an incremental run of
                            a version before 2.0.0-rc.51 anyway (it holds only
                            the last delta; refused by default)
  --user, -u <userId>       Restore a single user (default: all users)
  --overwrite               Clear existing data before import
  --skip-conflicts          Skip users with username/email conflicts
  --delete-on-success       Delete backup data after successful restore
  --move-on-success <path>  Move backup data after successful restore
  --verify-integrity        Verify integrity hashes after restore. Roll back and
                            exit 1 on failure; exit 2 if verification could not run
                            (integrity inactive or store unavailable). On a non-green
                            result the backup source is kept (never cleaned up).
  --private-key <pem>       Private key to decrypt a hybrid-encrypted backup
  --private-key-passphrase <s>  Passphrase protecting the private key (if any)
  --passphrase-file <path>  Passphrase to decrypt a symmetric-encrypted backup,
                            read from the first line of this file
  --decrypt-passphrase <s>  Same, given on the command line (prefer
                            --passphrase-file; also read from
                            PRYV_BACKUP_PASSPHRASE)
  --require-encrypted       Refuse a backup that is not encrypted
  --allow-plaintext         Restore a plaintext backup even though a decryption
                            secret was supplied (refused by default)

Inspect (reads the directory only; no storage access):
  --inspect <path>          List the runs of a backup directory (id, type,
                            snapshot time, users, encryption, stray directories)
                            and print one verdict: OK, DAMAGED (an incremental run
                            of a version before 2.0.0-rc.51 overwrote the full
                            backup), INCOMPLETE (a run is missing), or UNKNOWN
                            (an encrypted backup without chain.json: pass the
                            restore secret, --passphrase-file or --private-key)

General:
  --help, -h                Show this help

Restore exit codes (with --verify-integrity):
  0   all restored users verified clean (or nothing to verify)
  1   an integrity failure was found and rolled back
  2   restored, but one or more users could not be verified

Inspect exit codes:
  0   OK
  1   DAMAGED, INCOMPLETE or INVALID
  2   UNKNOWN (the secret is needed to read the manifest)
`);
}
