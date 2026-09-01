/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MfaMethod, MfaClientRequest } from './MfaMethod.ts';
import type { Profile as ProfileType } from './Profile.ts';
const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
const errors = require('errors').factory;
const { base32Encode, base32Decode, totpVerify } = require('./totp.ts');
const { encrypt, decrypt } = require('../acme/AtRestEncryption.ts');
const { resolveTotpKey } = require('./totpKeys.ts');

/**
 * Server-side TOTP (RFC 6238) as an in-process `MfaMethod`. The secret is
 * generated at enrolment, shown once (otpauth URI + Base32) for the
 * authenticator app, and stored on the profile encrypted at rest
 * (AES-256-GCM via the shared AtRestEncryption envelope). Verification runs
 * the primitive with a drift window and a per-user `lastUsedStep` replay
 * guard. Enrolment fails closed when no key material is configured.
 */

const SECRET_BYTES = 20; // 160-bit, RFC 4226 recommended
const ALGORITHM = 'sha1'; // authenticator-app interoperability baseline

type TotpCfg = {
  issuer?: string;
  digits?: number;
  periodSeconds?: number;
  driftSteps?: number;
  secretsKey?: string;
  [k: string]: unknown;
};

class TotpService implements MfaMethod {
  readonly name = 'totp';
  cfg: TotpCfg;
  digits: number;
  periodSeconds: number;
  driftSteps: number;

  constructor (totpCfg: TotpCfg = {}) {
    this.cfg = totpCfg;
    this.digits = totpCfg.digits ?? 6;
    this.periodSeconds = totpCfg.periodSeconds ?? 30;
    this.driftSteps = totpCfg.driftSteps ?? 1;
  }

  async #key (): Promise<Buffer> {
    const key = await resolveTotpKey(this.cfg);
    if (key == null) {
      throw errors.invalidOperation(
        'TOTP is enabled but no secret-encryption key is configured (set services.mfa.methods.totp.secretsKey or auth.adminAccessKey).',
        { id: 'mfa-totp-key-missing' }
      );
    }
    return key;
  }

  async #issuer (): Promise<string> {
    if (typeof this.cfg.issuer === 'string' && this.cfg.issuer.length > 0) return this.cfg.issuer;
    try {
      const { getConfig } = require('@pryv/boiler');
      const config = await getConfig();
      const domain = config.get('dns:domain');
      if (typeof domain === 'string' && domain.length > 0) return domain;
    } catch { /* fall through */ }
    return 'Pryv.io';
  }

  async enroll (username: string, profile: ProfileType, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = await this.#key();
    const secretRaw = crypto.randomBytes(SECRET_BYTES);
    const secretB32 = base32Encode(secretRaw);
    const issuer = await this.#issuer();
    const label = encodeURIComponent(`${issuer}:${username}`);
    const otpauthUri = `otpauth://totp/${label}?secret=${secretB32}` +
      `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${this.digits}&period=${this.periodSeconds}`;
    const p = profile as unknown as { method: string; totp: Record<string, unknown> };
    p.method = 'totp';
    p.totp = {
      secret: encrypt(secretB32, key), // encrypted-at-rest envelope
      algorithm: ALGORITHM,
      digits: this.digits,
      periodSeconds: this.periodSeconds,
      confirmedAt: null,
      lastUsedStep: -1
    };
    return { method: 'totp', otpauthUri, secret: secretB32 };
  }

  async challenge (_username: string, _profile: ProfileType, _clientRequest: MfaClientRequest): Promise<Record<string, unknown>> {
    // Nothing to send for TOTP; the client already has the app. Signal the
    // method so the UI renders the authenticator-code prompt.
    return { method: 'totp' };
  }

  async verify (_username: string, profile: ProfileType, clientRequest: MfaClientRequest): Promise<void> {
    const p = profile as unknown as { totp?: { secret: string; digits: number; periodSeconds: number; lastUsedStep: number } };
    if (!p.totp || !p.totp.secret) {
      throw errors.invalidParametersFormat('No TOTP enrolment for this user.', { id: 'invalid-mfa-code' });
    }
    const key = await this.#key();
    const secretB32 = decrypt(p.totp.secret, key).toString('utf8');
    const keyBytes = base32Decode(secretB32);
    const code = String((clientRequest.body || {}).code ?? '');
    const accepted = totpVerify(keyBytes, code, {
      digits: p.totp.digits,
      periodSeconds: p.totp.periodSeconds,
      driftSteps: this.driftSteps,
      algorithm: ALGORITHM,
      notAfterOrAtStep: p.totp.lastUsedStep
    });
    if (accepted == null) {
      throw errors.invalidParametersFormat('The provided MFA code is invalid.', { id: 'invalid-mfa-code' });
    }
    // Replay guard: never accept this step (or earlier) again. Caller persists.
    p.totp.lastUsedStep = accepted;
  }
}

export default TotpService;
export { TotpService };
