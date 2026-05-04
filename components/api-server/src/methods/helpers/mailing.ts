/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

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
exports.sendmail = function (emailSettings, template, recipient, subs, lang, callback) {
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
        const data = {
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
        const subsArray = [];
        for (const key of Object.keys(subs)) {
          subsArray.push({
            name: key,
            content: subs[key]
          });
        }
        const data = {
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
 * @param {EmailSettings} emailSettings
 * @param {string} template
 * @param {Recipient} recipient
 * @param {Substitutions} subs
 * @param {string} lang
 * @param {Callback} callback
 */
function _sendmailInProcess (emailSettings, template, recipient, subs, lang, callback) {
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
/**
 * @param {string} url
 * @param {MandrillData | MicroserviceData} data
 * @param {Callback} cb
 * @returns {void}
 */
function _sendmail (url, data, cb) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(async (res) => {
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON response */ }
    if (!res.ok) return cb(parseError(url, null, { ok: res.ok, status: res.status, body }));
    cb(null, { ok: res.ok, status: res.status, body });
  }, (err) => {
    cb(parseError(url, err, null));
  });
}
/**
 * @returns {any}
 */
function parseError (url, err, res) {
  // 1. Mail service answered with an error payload
  if (res != null && res.body != null && res.body.error != null) {
    const baseMsg = 'Sending email failed, mail-service answered with the following error:\n';
    return errors.unexpectedError(baseMsg + res.body.error);
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

/**
 * @typedef {(error?: Error | null, res?: any | null) => any} Callback
 */
/**
 * @typedef {{
 *   email: string;
 *   name: string;
 *   type: string | undefined | null;
 * }} Recipient
 */
/**
 * @typedef {{
 *   method: EmailMethod;
 *   url: string;
 *   key: string;
 *   welcomeTemplate: string;
 *   resetPasswordTemplate: string;
 * }} EmailSettings
 */
/** @typedef {'mandrill' | 'microservice' | 'in-process'} EmailMethod
 */
/**
 * @typedef {{
 *   key: string;
 *   template_name: string;
 *   template_content: Array<string>;
 *   message: MandrillMessage;
 * }} MandrillData
 */
/**
 * @typedef {{
 *   to: Recipient[];
 *   global_merge_vars: Array<MandrillSubstitution>;
 *   tags: Array<string>;
 * }} MandrillMessage
 */
/**
 * @typedef {{
 *   name: string;
 *   content: string;
 * }} MandrillSubstitution
 */
/**
 * @typedef {{
 *   key: string;
 *   to: Recipient;
 *   substitutions: Substitutions;
 * }} MicroserviceData
 */
/**
 * @typedef {{
 *   [x: string]: string;
 * }} Substitutions
 */
