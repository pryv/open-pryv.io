// @flow

const request = require('superagent');
const errors = require('../../../../errors').factory;
const URL = require('url');

type Callback = (error: ?Error, res: ?Object) => any;

type Recipient = {
  email: string,
  name: string,
  type: ?string
};

type EmailSettings = {
  method: EmailMethod,
  url: string,
  key: string,
  welcomeTemplate: string,
  resetPasswordTemplate: string
};

type EmailMethod = 'mandrill' | 'microservice';

type MandrillData = {
  key: string,
  template_name: string,
  template_content: Array<string>,
  message: MandrillMessage
};

type MandrillMessage = {
  to: Recipient[],
  global_merge_vars: Array<MandrillSubstitution>,
  tags: Array<string>
}

type MandrillSubstitution = {
  name: string,
  content: string
};

type MicroserviceData = {
  key: string,
  to: Recipient,
  substitutions: Substitutions
};

type Substitutions = {[string]: string};

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
exports.sendmail = function (emailSettings: EmailSettings, template: string,
  recipient: Recipient, subs: Substitutions, lang: string, callback: Callback): void {
    
  const mailingMethod = emailSettings.method;
  
  // Sending via Pryv service-mail
  
  switch (mailingMethod) {
    case 'microservice': {
      const url = URL.resolve(emailSettings.url, template + '/' + lang);
      const data = {
        key: emailSettings.key,
        to: recipient,
        substitutions: subs
      };
      
      _sendmail(url, data, callback);
      
    } break;
    
    case 'mandrill': {
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
      
    } break;
    
    default: {
      callback(errors.unexpectedError('Missing or invalid email method.'));
    }
  }
  // NOT REACHED
};

function _sendmail(url: string, data: MandrillData | MicroserviceData, cb: Callback): void {
  request.post(url).send(data).end((err, res) => {
    if (err!=null || (res!=null && !res.ok)) {
      return cb(parseError(url, err, res));
    }
    cb(null, res);
  });
}

function parseError(url, err, res) {
  
  // 1. Mail service failed
  if (res!=null && res.body!=null && res.body.error!=null) {
    const baseMsg = 'Sending email failed, mail-service answered with the following error:\n';
    return errors.unexpectedError(baseMsg + res.body.error);
  }
  
  // 2. Superagent failed
  const errorMsg = err.message;
  let baseMsg = `Sending email failed while trying to reach mail-service at: ${url}.\n`;
  // 2.1 Because of SSL certificates
  if (errorMsg.match(/certificate/i)) {
    baseMsg += 'Trying to do SSL but certificates are invalid: ';
  }
  // 2.2 Because of unreachable url
  else if (errorMsg.match(/not found/i)) {
    baseMsg += 'Endpoint seems unreachable: ';
  }
  return errors.unexpectedError(baseMsg + errorMsg);
  
}
