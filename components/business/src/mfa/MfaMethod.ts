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
 * `checkEnrolParams` validates an activate body (step-up fields excluded)
 * before anything else happens, throwing `invalid-parameters-format` when it
 * carries what the method does not accept. `enroll` prepares a pending
 * enrolment on the profile (it sends nothing); the API layer then opens the
 * MFA session and calls `challenge`, which is also the login-time and re-send
 * step (an SMS for the SMS method). `verify` checks a submitted code.
 * `enroll` and `challenge` may return extra fields to merge into the API reply
 * (e.g. TOTP's otpauth URI); `verify` throws `invalid-mfa-code` on a bad code.
 */
export interface MfaClientRequest {
  headers: Record<string, unknown>;
  /** What the method may read of the client request: `code` on a verify; nothing else is passed. */
  body: Record<string, unknown>;
  /** The pending MFA session (its mfaToken); set on challenge and verify of a session. */
  sessionId?: string;
}

export interface MfaMethod {
  readonly name: string;
  checkEnrolParams (params: Record<string, unknown>): void;
  enroll (username: string, profile: Profile, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  challenge (username: string, profile: Profile, clientRequest: MfaClientRequest): Promise<Record<string, unknown>>;
  verify (username: string, profile: Profile, clientRequest: MfaClientRequest): Promise<void>;
}
