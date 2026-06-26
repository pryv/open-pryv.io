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
//   node bin/backup.js --output /path/to/backup --since 1679000000
//   node bin/backup.js --output /path/to/backup --max-chunk-size 50
//   node bin/backup.js --output /path/to/backup --include-ephemeral
//   node bin/backup.js --output /path/to/backup --recipient-pubkey recipient.pub.pem
//   node bin/backup.js --output /path/to/backup --encrypt-passphrase 's3cret'
//
// Restore:
//   node bin/backup.js --restore /path/to/backup
//   node bin/backup.js --restore /path/to/backup --overwrite
//   node bin/backup.js --restore /path/to/backup --user userId123
//   node bin/backup.js --restore /path/to/backup --skip-conflicts --move-on-success /path/to/done
//   node bin/backup.js --restore /path/to/backup --skip-conflicts --delete-on-success
//   node bin/backup.js --restore /path/to/backup --private-key recipient.key.pem
//   node bin/backup.js --restore /path/to/backup --decrypt-passphrase 's3cret'

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

    // Initialize storage subsystems
    await initStorage();

    if (args.restore) {
      await runRestore(args);
    } else if (args.output) {
      await runBackup(args);
    } else {
      console.error('Error: --output or --restore is required');
      printUsage();
      process.exit(1);
    }

    process.exit(0);
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
  const { createFilesystemBackupWriter, createBackupDecryptor } = require('storages/interfaces/backup/index.ts');
  const BackupOrchestrator = require('business/src/backup/BackupOrchestrator.ts').default;

  const encryptor = buildEncryptor(args);

  const manifestPath = path.join(args.output, 'manifest.json');
  const encryptionPath = path.join(args.output, 'encryption.json');
  let previousManifest = null;

  if (fs.existsSync(manifestPath)) {
    if (!args.incremental) {
      throw new Error(
        `Backup already exists at ${args.output} (manifest.json found). ` +
        'Use --incremental for incremental backup, or choose a different output path.'
      );
    }
    // Read previous manifest for per-user timestamp detection. If the existing
    // backup is encrypted, the matching secret is needed to read it — supply
    // --decrypt-passphrase / --private-key alongside the encrypt option.
    if (fs.existsSync(encryptionPath)) {
      const envelope = JSON.parse(fs.readFileSync(encryptionPath, 'utf8'));
      const decryptor = createBackupDecryptor(envelope, buildDecryptSecrets(args, true));
      previousManifest = JSON.parse(decryptor.decryptBuffer(fs.readFileSync(manifestPath)).toString('utf8'));
    } else {
      previousManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    console.log(`Incremental backup: using previous backup timestamps from ${args.output}`);
  } else if (args.incremental) {
    console.log('No previous backup found — running full backup instead');
  }

  if (encryptor) {
    console.log(`Encryption: ${encryptor.envelope.mode} (${encryptor.envelope.alg}) — destination bytes are ciphertext only`);
  }

  const writer = createFilesystemBackupWriter(args.output, {
    maxChunkSize: (args.maxChunkSize || 50) * 1024 * 1024,
    compress: args.compress,
    encryptor
  });

  const orchestrator = new BackupOrchestrator();
  await orchestrator.init();

  const options = {
    includeEphemeral: args.includeEphemeral,
    incremental: args.incremental && previousManifest != null,
    previousManifest
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

async function runRestore (args) {
  const { createFilesystemBackupReader, createBackupDecryptor } = require('storages/interfaces/backup/index.ts');
  const RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator.ts').default;

  // Encrypted backups carry a cleartext `encryption.json` envelope at the root.
  let decryptor = null;
  const encryptionPath = path.join(args.restore, 'encryption.json');
  if (fs.existsSync(encryptionPath)) {
    const envelope = JSON.parse(fs.readFileSync(encryptionPath, 'utf8'));
    console.log(`Encrypted backup detected: ${envelope.mode} (${envelope.alg})`);
    decryptor = createBackupDecryptor(envelope, buildDecryptSecrets(args, false));
  }

  const reader = createFilesystemBackupReader(args.restore, { decryptor });

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

  // Post-restore integrity verification
  if (args.verifyIntegrity && report.restored.length > 0) {
    console.log('\nVerifying integrity of restored data...');
    const IntegrityCheck = require('business/src/integrity/IntegrityCheck.ts').default;
    const checker = new IntegrityCheck();
    await checker.init();

    const failedUsers = [];
    for (const { userId, username } of report.restored) {
      const intReport = await checker.checkUser(userId);
      const errorCount = intReport.events.errors.length + intReport.accesses.errors.length;
      if (intReport.ok) {
        console.log(`  [OK] ${username} — events=${intReport.events.checked} accesses=${intReport.accesses.checked}`);
      } else {
        console.log(`  [FAIL] ${username} — ${errorCount} integrity error(s)`);
        for (const err of intReport.events.errors.slice(0, 3)) {
          console.log(`    Event ${err.eventId}: ${err.error}`);
        }
        for (const err of intReport.accesses.errors.slice(0, 3)) {
          console.log(`    Access ${err.accessId}: ${err.error}`);
        }
        failedUsers.push({ userId, username, intReport });
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
  }

  // Post-restore cleanup
  if (report.restored.length > 0) {
    if (args.deleteOnSuccess) {
      fs.rmSync(args.restore, { recursive: true, force: true });
      console.log(`Backup deleted: ${args.restore}`);
    } else if (args.moveOnSuccess) {
      fs.mkdirSync(path.dirname(args.moveOnSuccess), { recursive: true });
      fs.renameSync(args.restore, args.moveOnSuccess);
      console.log(`Backup moved to: ${args.moveOnSuccess}`);
    }
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

/** Build the secrets needed to decrypt an encrypted backup (restore or incremental). */
function buildDecryptSecrets (args, forIncremental) {
  const passphrase = args.decryptPassphrase || args.encryptPassphrase || process.env.PRYV_BACKUP_PASSPHRASE;
  const secrets = { passphrase };
  if (args.privateKey) {
    secrets.privateKeyPem = fs.readFileSync(args.privateKey, 'utf8');
    secrets.privateKeyPassphrase = args.privateKeyPassphrase || process.env.PRYV_BACKUP_PRIVATE_KEY_PASSPHRASE;
  }
  if (forIncremental && !secrets.passphrase && !secrets.privateKeyPem) {
    throw new Error(
      'The existing backup is encrypted; incremental backup needs the matching secret ' +
      'to read its previous manifest. Pass --decrypt-passphrase or --private-key.'
    );
  }
  return secrets;
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
  if (args.recipientPubkey && args.encryptPassphrase) {
    console.error('Error: --recipient-pubkey and --encrypt-passphrase are mutually exclusive (pick one key model)');
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
  --max-chunk-size <MB>     Max output file size in MB, compressed (default: 50)
  --include-ephemeral       Include sessions and password-reset-requests
  --incremental             Only export changes since previous backup (auto-detects per-user)

Encryption (opt-in — without these flags output is plaintext as before):
  --recipient-pubkey <pem>  Encrypt output with a recipient RSA public key
                            (recommended): the backup host holds no decrypt
                            secret — only the private-key holder can restore.
  --encrypt-passphrase <s>  Encrypt output with a passphrase (scrypt-derived).
                            Simpler, but this host can decrypt its own backup.
                            Also read from PRYV_BACKUP_PASSPHRASE if omitted.
                            (Encrypting an existing incremental backup needs the
                            matching secret to read the previous manifest.)

Restore:
  --restore, -r <path>      Restore from backup directory
  --user, -u <userId>       Restore a single user (default: all users)
  --overwrite               Clear existing data before import
  --skip-conflicts          Skip users with username/email conflicts
  --delete-on-success       Delete backup data after successful restore
  --move-on-success <path>  Move backup data after successful restore
  --verify-integrity        Verify integrity hashes after restore; roll back on failure
  --private-key <pem>       Private key to decrypt a hybrid-encrypted backup
  --private-key-passphrase <s>  Passphrase protecting the private key (if any)
  --decrypt-passphrase <s>  Passphrase to decrypt a symmetric-encrypted backup
                            (also read from PRYV_BACKUP_PASSPHRASE)

General:
  --help, -h                Show this help
`);
}
