/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { isInProcessSmtpMissing } from 'business/src/emails/mailCapability.ts';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('methods:helpers:mailing');

// Client-facing message for any mail-delivery failure. The diagnostic
// detail (mail-service URL, upstream HTTP status, transport errors) is
// operator-only: it is logged, never returned — the reset-password
// endpoint relays this error message to unauthenticated callers.
const GENERIC_SENDMAIL_ERROR = 'Sending email failed. Please try again later or contact support.';

// Every failure `sendmail` reports through its callback has already been
// logged here, once, at the level it deserves: a recipient the SMTP server
// refused (user input) or deferred (a temporary refusal) is a warning,
// anything else (transport down, template missing, PlatformDB not ready, bad
// settings) is an error. The returned error
// carries this mark so that a caller sending in the background (the response
// already went out) does not log it a second time. A global symbol, so the
// mark is seen whichever way this module was loaded.
const LOGGED_MAIL_FAILURE = Symbol.for('pryv.mailing.failureLogged');

function markLogged<E extends Error> (err: E): E {
  Object.defineProperty(err, LOGGED_MAIL_FAILURE, { value: true, enumerable: false });
  return err;
}

/**
 * True when `err` is a mail failure `sendmail` already logged. A caller that
 * cannot hand the error to the client (a background send) skips its own log
 * for it; a caller that answers the client with it changes nothing.
 */
export function isLoggedMailFailure (err: unknown): boolean {
  return err != null && typeof err === 'object' && (err as { [LOGGED_MAIL_FAILURE]?: boolean })[LOGGED_MAIL_FAILURE] === true;
}

// Set on the error `sendmail` reports when the SMTP server rejected the
// recipient address (see recipientRefusal). The error itself stays the generic
// one, so a caller that must not tell the address apart (password reset) is
// unchanged; a caller whose own input the address is answers a 400 instead.
const RECIPIENT_REJECTED = Symbol.for('pryv.mailing.recipientRejected');

/**
 * True when `err` is a `sendmail` failure caused by the SMTP server rejecting
 * the recipient address (a permanent refusal, not a temporary deferral).
 */
export function isRecipientRejected (err: unknown): boolean {
  return err != null && typeof err === 'object' && (err as { [RECIPIENT_REJECTED]?: boolean })[RECIPIENT_REJECTED] === true;
}

// Set on the error `sendmail` reports when the SMTP server deferred the
// recipient (a temporary refusal of that address, not a transport failure).
const RECIPIENT_DEFERRED = Symbol.for('pryv.mailing.recipientDeferred');

/** True when `err` is a `sendmail` failure caused by the SMTP server deferring the recipient. */
export function isRecipientDeferred (err: unknown): boolean {
  return err != null && typeof err === 'object' && (err as { [RECIPIENT_DEFERRED]?: boolean })[RECIPIENT_DEFERRED] === true;
}

/**
 * The client-facing answer for a recipient address the SMTP server rejected,
 * on a request where the address is the caller's own input.
 */
export function recipientRejectedError (email: string): Error {
  return errors.invalidParametersFormat('The mail server refused this email address. Please check it.',
    { email, reason: 'recipient-rejected' });
}

type SmtpErrorLike = { code?: unknown; command?: unknown; responseCode?: unknown };

/**
 * How the SMTP server refused the recipient, or null when it did not.
 * nodemailer reports a refused RCPT TO (the only recipient, or all of them)
 * as `code: 'EENVELOPE'`, `command: 'RCPT TO'`, with the server's reply in
 * the message and its code in `responseCode`:
 * - a 5xx reply (e.g. "550 5.1.2 Domain not found") is `'rejected'`: the
 *   address itself is refused, user input;
 * - a 4xx reply (greylisting "450 4.7.1", mailbox full "452") is
 *   `'deferred'`: the server asks to try again later. Nothing here sends a
 *   mail twice, so the mail is not delivered.
 * A refusal without a reply code reads as `'rejected'`. A refused MAIL FROM,
 * a refused DATA or a connection failure is not about the recipient and
 * stays a transport failure (null).
 */
export function recipientRefusal (err: unknown): 'rejected' | 'deferred' | null {
  if (err == null || typeof err !== 'object') return null;
  const e = err as SmtpErrorLike;
  if (e.code !== 'EENVELOPE' || e.command !== 'RCPT TO') return null;
  const replyCode = typeof e.responseCode === 'number' ? e.responseCode : NaN;
  return replyCode >= 400 && replyCode < 500 ? 'deferred' : 'rejected';
}

/**
 * Helper function that modularizes the sending of an email,
 * should it be via Mandrill, the Pryv service-mail microservice, or
 * the in-process `mail` component.
 * @param emailSettings: email settings object
 * @param template: email template (welcome or reset password)
 * @param recipient: email recipient (to)
 * @param subs: object containing the variables to be substituted in the email
 * @param lang: user prefered language
 * @param callback(err,res): called once the email is sent
 */
export const sendmail = function (emailSettings: EmailSettings, template: string, recipient: Recipient, subs: Substitutions, lang: string, callback: MailCallback): void {
  const mailingMethod = emailSettings.method;
  switch (mailingMethod) {
    case 'in-process':
      // In-process delivery: renders Pug templates pulled from PlatformDB
      // and ships via the configured SMTP / sendmail transport. No HTTP
      // boundary, no shared-key auth. First call in the worker process
      // lazy-initialises the `mail` component (master seeds templates but
      // doesn't init the delivery pipeline per-worker).
      _sendmailInProcess(emailSettings, template, recipient, subs, lang, callback);
      break;
    case 'microservice':
      {
        let url: string;
        try {
          url = new URL(template + '/' + lang, emailSettings.url).toString();
        } catch (err) {
          // A malformed services.email.url: reported through the callback,
          // never thrown at a caller that sends in the background. The error
          // is the one a request answering with it gave before (an unexpected
          // error wrapping the URL error), so its client text is unchanged.
          logger.error('Sending email failed, invalid mail-service URL: ' + (err instanceof Error ? err.message : String(err)));
          callback(markLogged(errors.unexpectedError(err)));
          return;
        }
        const data: MicroserviceData = {
          key: emailSettings.key,
          to: recipient,
          substitutions: subs
        };
        _sendmail(url, data, callback);
      }
      break;
    case 'mandrill':
      {
        const url = emailSettings.url;
        const subsArray: MandrillSubstitution[] = [];
        for (const key of Object.keys(subs)) {
          subsArray.push({
            name: key,
            content: subs[key]
          });
        }
        const data: MandrillData = {
          key: emailSettings.key,
          template_name: template,
          template_content: [],
          message: {
            to: [recipient],
            global_merge_vars: subsArray,
            tags: [template]
          }
        };
        _sendmail(url, data, callback);
      }
      break;
    default: {
      logger.error('Sending email failed: missing or invalid services.email.method (' + String(mailingMethod) + ')');
      callback(markLogged(errors.unexpectedError('Missing or invalid email method.')));
    }
  }
  // NOT REACHED
};

/**
 * Route a send through the in-process `mail` component. Lazy-inits the
 * façade on first use per worker. Errors are forwarded via callback, same
 * contract as the legacy HTTP paths — registration/reset-password callers
 * already treat mail failures as non-fatal.
 *
 */
function _sendmailInProcess (emailSettings: EmailSettings, template: string, recipient: Recipient, subs: Substitutions, lang: string, callback: MailCallback): void {
  (async () => {
    const mail = require('mail');
    if (!mail.isActive()) {
      // No SMTP host: mail is not configured (the boot warns once). The send
      // is skipped like a switched-off mail class, not reported as a failure.
      if (isInProcessSmtpMissing(emailSettings)) {
        logger.debug('Mail not configured (services.email.smtp.host is not set): ' + template + ' mail not sent');
        return null;
      }
      const platformDB = require('storages').platformDB;
      if (!platformDB || typeof platformDB.getAllMailTemplates !== 'function') {
        throw errors.unexpectedError('in-process mail: PlatformDB is not initialised — storages.init() must run before any sendmail call.');
      }
      await mail.init({
        getAllMailTemplates: platformDB.getAllMailTemplates.bind(platformDB),
        smtp: emailSettings.smtp,
        from: emailSettings.from,
        defaultLang: emailSettings.defaultLang || 'en'
      });
    }
    const result = await mail.send({
      type: template,
      lang,
      recipient,
      substitutions: subs
    });
    return result;
  })().then(
    (res) => callback(null, res),
    (err) => {
      if (err && err.id === 'unknown-resource') {
        const message = 'in-process mail: no template found for ' + template + '/' + lang;
        logger.error('Sending email failed (in-process): ' + message);
        return callback(markLogged(errors.unexpectedError(message)));
      }
      // Transport/config errors can carry internal detail (SMTP host,
      // connection failures) — same operator-only rule as parseError.
      const detail = err instanceof Error ? err.message : String(err);
      const refusal = recipientRefusal(err);
      if (refusal === 'rejected') {
        // The address the account gave was refused (unknown domain or
        // mailbox): user input, not a fault of this server. The message
        // carries the SMTP server's reply.
        logger.warn('Sending email failed (in-process): ' + template + ' mail, recipient rejected: ' + detail);
        const failure = markLogged(errors.unexpectedError(GENERIC_SENDMAIL_ERROR));
        Object.defineProperty(failure, RECIPIENT_REJECTED, { value: true, enumerable: false });
        return callback(failure);
      } else if (refusal === 'deferred') {
        // A temporary refusal (greylisting, mailbox full): not a fault of
        // this server either, but the mail is lost, nothing re-sends it.
        logger.warn('Sending email failed (in-process): ' + template + ' mail, recipient deferred by the SMTP server (temporary), not sent and not retried: ' + detail);
        const failure = markLogged(errors.unexpectedError(GENERIC_SENDMAIL_ERROR));
        Object.defineProperty(failure, RECIPIENT_DEFERRED, { value: true, enumerable: false });
        return callback(failure);
      } else {
        logger.error('Sending email failed (in-process): ' + template + ' mail: ' + detail);
      }
      return callback(markLogged(errors.unexpectedError(GENERIC_SENDMAIL_ERROR)));
    }
  );
}
type MailResponse = { ok: boolean; status: number; body: unknown };

function _sendmail (url: string, data: MicroserviceData | MandrillData, cb: MailCallback): void {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(async (res) => {
    let body: unknown = null;
    try { body = await res.json(); } catch (_) { /* non-JSON response */ }
    if (!res.ok) return cb(parseError(url, null, { ok: res.ok, status: res.status, body }));
    cb(null, { ok: res.ok, status: res.status, body });
  }, (err: Error) => {
    cb(parseError(url, err, null));
  });
}
function parseError (url: string, err: Error | null, res: MailResponse | null): Error {
  let detail: string;
  // 1. Mail service answered with an error payload
  if (res != null && res.body != null && typeof res.body === 'object' && 'error' in res.body && (res.body as { error: unknown }).error != null) {
    detail = 'mail-service answered with the following error:\n' + String((res.body as { error: unknown }).error);
  } else {
    // 2. HTTP-layer failure (fetch reject or non-2xx without error body)
    const errorMsg = err != null ? err.message : `HTTP ${res?.status ?? 'unknown'}`;
    let hint = '';
    if (errorMsg.match(/certificate/i)) {
      hint = 'Trying to do SSL but certificates are invalid: ';
    } else if (errorMsg.match(/not found|ENOTFOUND|ECONNREFUSED/i)) {
      hint = 'Endpoint seems unreachable: ';
    }
    detail = `could not reach mail-service at: ${url}.\n${hint}${errorMsg}`;
  }
  logger.error('Sending email failed, ' + detail);
  return markLogged(errors.unexpectedError(GENERIC_SENDMAIL_ERROR));
}

type MailCallback = (error?: Error | null, res?: MailResponse | null) => unknown;
type Recipient = {
  email: string;
  name: string;
  type: string | undefined | null;
};
type EmailSettings = {
  method: EmailMethod;
  url: string;
  key: string;
  welcomeTemplate: string;
  resetPasswordTemplate: string;
  smtp?: { host?: string; [k: string]: unknown };
  from?: string;
  defaultLang?: string;
};
type EmailMethod = 'mandrill' | 'microservice' | 'in-process';
type MandrillData = {
  key: string;
  template_name: string;
  template_content: Array<string>;
  message: MandrillMessage;
};
type MandrillMessage = {
  to: Recipient[];
  global_merge_vars: Array<MandrillSubstitution>;
  tags: Array<string>;
};
type MandrillSubstitution = {
  name: string;
  content: string;
};
type MicroserviceData = {
  key: string;
  to: Recipient;
  substitutions: Substitutions;
};
type Substitutions = {
  [x: string]: string;
};
