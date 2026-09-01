/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Profile } from './Profile.ts';

/**
 * Common contract for every MFA method (in-process TOTP as well as the
 * HTTP-provider SMS adapters). The registry in `./index.ts` resolves a method
 * by name (from config) or per user (from the stored profile) and the API
 * layer drives it through these three calls.
 *
 * `enroll` starts a setup flow, `challenge` is the login-time / resend step,
 * `verify` checks a submitted code. `enroll` and `challenge` may return extra
 * fields to merge into the API reply (e.g. TOTP's otpauth URI); `verify`
 * throws `invalid-mfa-code` on a bad code.
 */
export interface MfaClientRequest {
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
}

export interface MfaMethod {
  readonly name: string;
  enroll (username: string, profile: Profile, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  challenge (username: string, profile: Profile, clientRequest: MfaClientRequest): Promise<Record<string, unknown>>;
  verify (username: string, profile: Profile, clientRequest: MfaClientRequest): Promise<void>;
}
