/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { deriveKey, KEY_BYTES } = require('../acme/AtRestEncryption.ts');

/**
 * Resolve the 32-byte key that encrypts TOTP secrets at rest (operator
 * sign-off S1, layered order):
 *   1. `services.mfa.methods.totp.secretsKey` (base64 32-byte) when set;
 *   2. else HKDF-derive from `auth.adminAccessKey` (purpose-labeled, the same
 *      precedent as Platform's per-purpose at-rest keys);
 *   3. else null — the caller refuses TOTP enrolment (fail closed), never
 *      breaking login for users who are not enrolled.
 *
 * Rotating `auth.adminAccessKey` invalidates derived TOTP secrets (users fall
 * back to recovery codes and re-enrol); set `secretsKey` for independent
 * rotation. Documented in the operator notes.
 */
const TOTP_KEY_PURPOSE = 'mfa-totp-secrets-v1';

type TotpCfg = { secretsKey?: string; [k: string]: unknown };

async function resolveTotpKey (totpCfg: TotpCfg | null | undefined): Promise<Buffer | null> {
  const secretsKey = totpCfg?.secretsKey;
  if (typeof secretsKey === 'string' && secretsKey.length > 0) {
    const buf = Buffer.from(secretsKey, 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(`services.mfa.methods.totp.secretsKey must decode to ${KEY_BYTES} bytes (base64), got ${buf.length}`);
    }
    return buf;
  }
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();
  const adminKey = config.get('auth:adminAccessKey');
  if (typeof adminKey === 'string' && adminKey.length > 0) {
    return deriveKey(adminKey, TOTP_KEY_PURPOSE);
  }
  return null;
}

export { resolveTotpKey, TOTP_KEY_PURPOSE };
