/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The "verify this address" link mailed to a holder: built for the
 * verification mail (an added or resent address) and for the welcome mail (the
 * founding address, when it is not proved).
 */

import { getConfig } from '@pryv/boiler';
import timestamp from 'unix-timestamp';
import * as C from './constants.ts';
import * as container from './container.ts';
import { describeVerificationMail } from './mailCapability.ts';
import { mintToken, hashToken } from './tokens.ts';

/**
 * The link to the operator's verification page. It carries the username as
 * well as the token: the landing page has to address
 * `/:username/account/verify-email`, and it cannot derive the username from the
 * address, because PlatformDB stores emails hashed when the operator enables
 * that mode. The page URL may already carry a query (the reference app needs
 * `pryvServiceInfoUrl` on it), so the separator is chosen rather than always
 * appending '?', which would fold our parameters into the operator's last one.
 */
export function buildVerifyLink (pageURL: string, token: string, username: string): string {
  const separator = pageURL.includes('?') ? '&' : '?';
  return pageURL + separator + 'verifyToken=' + encodeURIComponent(token) +
    '&username=' + encodeURIComponent(username);
}

/**
 * For the welcome mail of a new account: when the verification mail is enabled
 * and the founding address is not proved (no code at registration), mint a
 * verification token for it, store its hash, and return the mail substitutions
 * the verification mail also carries: the link, and the page URL + token for a
 * holder whose mail client breaks the link. Null otherwise. Stamping the token
 * also starts the resend cooldown, as a verification mail would.
 */
export async function foundingVerifyLink (userId: string, username: string, email: string): Promise<{ VERIFY_LINK: string, VERIFY_URL: string, VERIFY_TOKEN: string } | null> {
  const config = await getConfig();
  if (!describeVerificationMail(config).enabled) return null;
  const ev = await container.findRawByValue(userId, email);
  if (ev == null || C.isProvedOwnership(ev.content)) return null;
  const maxAgeMs = await container.getVerificationTokenMaxAgeMs();
  const token = mintToken();
  const now = timestamp.now();
  await container.stampVerification(userId, ev, hashToken(token), timestamp.now(maxAgeMs / 1000), now);
  const pageURL = config.get('auth:emailVerificationPageURL') as string;
  return { VERIFY_LINK: buildVerifyLink(pageURL, token, username), VERIFY_URL: pageURL, VERIFY_TOKEN: token };
}
