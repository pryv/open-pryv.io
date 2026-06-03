/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;

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
export const sendmail = function (emailSettings: EmailSettings, template: string, recipient: Recipient, subs: Substitutions, lang: string, callback: Callback): void {
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
        const url = new URL(template + '/' + lang, emailSettings.url).toString();
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
      callback(errors.unexpectedError('Missing or invalid email method.'));
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
function _sendmailInProcess (emailSettings: EmailSettings, template: string, recipient: Recipient, subs: Substitutions, lang: string, callback: Callback): void {
  (async () => {
    const mail = require('mail');
    if (!mail.isActive()) {
      const platformDB = require('storages').platformDB;
      if (!platformDB || typeof platformDB.getAllMailTemplates !== 'function') {
        throw errors.unexpectedError('in-process mail: PlatformDB is not initialised — storages.init() must run before any sendmail call.');
      }
      if (!emailSettings.smtp || !emailSettings.smtp.host) {
        throw errors.unexpectedError('in-process mail: services.email.smtp.host is required.');
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
        return callback(errors.unexpectedError('in-process mail: no template found for ' + template + '/' + lang));
      }
      return callback(err);
    }
  );
}
type MailResponse = { ok: boolean; status: number; body: unknown };

function _sendmail (url: string, data: MicroserviceData | MandrillData, cb: Callback): void {
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
  // 1. Mail service answered with an error payload
  if (res != null && res.body != null && typeof res.body === 'object' && 'error' in res.body && (res.body as { error: unknown }).error != null) {
    const baseMsg = 'Sending email failed, mail-service answered with the following error:\n';
    return errors.unexpectedError(baseMsg + String((res.body as { error: unknown }).error));
  }
  // 2. HTTP-layer failure (fetch reject or non-2xx without error body)
  const errorMsg = err != null ? err.message : `HTTP ${res?.status ?? 'unknown'}`;
  let baseMsg = `Sending email failed while trying to reach mail-service at: ${url}.\n`;
  if (errorMsg.match(/certificate/i)) {
    baseMsg += 'Trying to do SSL but certificates are invalid: ';
  } else if (errorMsg.match(/not found|ENOTFOUND|ECONNREFUSED/i)) {
    baseMsg += 'Endpoint seems unreachable: ';
  }
  return errors.unexpectedError(baseMsg + errorMsg);
}

type Callback = (error?: Error | null, res?: MailResponse | null) => unknown;
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
