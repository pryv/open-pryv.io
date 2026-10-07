/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Placeholder and weak-secret detection for configuration values.
 *
 * One predicate for the boot validation, `bin/check-config.js`, the bootstrap
 * bundle issuer and the mail capability check, so they never disagree on what
 * counts as "not set yet".
 */

export const MIN_SECRET_LENGTH = 16;

const PLACEHOLDER_SECRETS: readonly string[] = ['override me', 'overrideme', 'override-me', 'override_me', 'changeme', 'change me',
  'change-me', 'change_me', 'secret', 'password', 'admin', 'adminkey', 'todo', 'xxx'];

// "OVERRIDE ME", "CHANGE_ME_WITH_SOMETHING", "please-replace-me", … anywhere in the value.
export const PLACEHOLDER_PATTERN = /(^|[^a-z])(override|change|replace)[ _-]?me([^a-z]|$)/i;

/** True when the value is a template placeholder rather than a real setting. */
export function isPlaceholderValue (value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return PLACEHOLDER_PATTERN.test(value) || PLACEHOLDER_SECRETS.includes(value.trim().toLowerCase());
}

/**
 * Why a secret value is not acceptable, or null when it is.
 * `production` also enforces MIN_SECRET_LENGTH.
 */
export function weakSecretReason (value: unknown, options: { production?: boolean } = {}): string | null {
  if (typeof value !== 'string') return null;
  if (isPlaceholderValue(value)) return 'is a placeholder value';
  if (options.production === true && value.length < MIN_SECRET_LENGTH) {
    return `is shorter than ${MIN_SECRET_LENGTH} characters`;
  }
  return null;
}
