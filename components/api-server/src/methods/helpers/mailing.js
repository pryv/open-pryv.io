/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const request = require('superagent');
const errors = require('errors').factory;

/**
 * Helper function that modularizes the sending of an email,
 * should it be via Mandrill or via Pryv service-mail
 * @param emailSettings: email settings object
 * @param template: email template (welcome or reset password)
 * @param recipient: email recipient (to)
 * @param subs: object containing the variables to be substituted in the email
 * @param lang: user prefered language
 * @param callback(err,res): called once the email is sent
 */
exports.sendmail = function (emailSettings, template, recipient, subs, lang, callback) {
  const mailingMethod = emailSettings.method;
  // Sending via Pryv service-mail
  switch (mailingMethod) {
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
 * @param {string} url
 * @param {MandrillData | MicroserviceData} data
 * @param {Callback} cb
 * @returns {void}
 */
function _sendmail (url, data, cb) {
  request
    .post(url)
    .send(data)
    .end((err, res) => {
      if (err != null || (res != null && !res.ok)) {
        return cb(parseError(url, err, res));
      }
      cb(null, res);
    });
}
/**
 * @returns {any}
 */
function parseError (url, err, res) {
  // 1. Mail service failed
  if (res != null && res.body != null && res.body.error != null) {
    const baseMsg = 'Sending email failed, mail-service answered with the following error:\n';
    return errors.unexpectedError(baseMsg + res.body.error);
  }
  // 2. Superagent failed
  const errorMsg = err.message;
  let baseMsg = `Sending email failed while trying to reach mail-service at: ${url}.\n`;
  // 2.1 Because of SSL certificates
  if (errorMsg.match(/certificate/i)) {
    baseMsg += 'Trying to do SSL but certificates are invalid: ';
  } else if (errorMsg.match(/not found/i)) { // 2.2 Because of unreachable url
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
/** @typedef {'mandrill' | 'microservice'} EmailMethod
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
