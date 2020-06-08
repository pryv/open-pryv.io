# Service mail

 Sends emails on behalf of a Pryv.io core for user password reset and welcome emails. 

## API

### POST /sendmail/:template/:lang

Request the sending of an email, where:
- **:template** defines the type of email (e.g. welcome).
- **:lang** defines the language in which the email should be written.

Each request should contain the following body parameters:
- **substitutions**: a mapping of variables that will be substituted in the email (e.g. _{name: 'bob'}_)
- **to**: information about the recipient (in the form _{name: 'bob', email: 'bob@domain.com'}_)
- **key**: shared key used to authenticate the requesting service against the mail service

## Configuration

Service-mail can be configured by providing a configuration file (.json, .hjson or .yaml) containing settings that we list and explain below.

### Templates

Templates consist of [pug](https://pugjs.org/api/getting-started.html) files, arranged into folders according to email types and langage codes, see the [default templates](https://github.com/pryv/service-mail/tree/master/templates) for example.

The default root folder for templates is _/templates/_, it can be configured by providing **templates.root**.

If the template for requested language does not exist, the service will try to find another template for the same email type but with a default language (e.g. english instead of french). Default language can be defined in configuration by providing **templates.defaultLang**.

### Transport

The service-mail allows to define two types of transport, smtp or sendmail command.

#### SMTP

SMTP transport is used by default, it allows to define an external mail delivery service through configuration:
- **smtp.host**: smtp host (e.g. smtp.ethereal.email)
- **smtp.port**: smtp port (e.g. 587)
- **smtp.auth.user**, **smtp.auth.pass**: credentials to authenticate against an external mail service (e.g. sendgrid)

#### Sendmail

An alternative is to use the sendmail command of the machine on which service-mail is running.
It has to be explicitly activated through configuration:
- **sendmail.active**: true
- **sendmail.path**: path to the sendmail command on the machine

### Other settings

Here is a sample configuration that shows all available settings alongside with some explanation:

``` yml
{
  // Logging settings
  logs: {
    prefix: '',
    console: { active: true, level: 'info', colorize: true }, 
    file: { active: false },
  },
  email: {
    message: {
      // Sender name and email address
      from: {
        name: "Ethereal Email",
        address: "btvryvs5al5mjpa3@ethereal.email"
      }
    },
    preview: false, // If true, it will open a webpage with a preview
    send: true // Activate/deactivate the actual sending (prod/test env)
  },
  // By default, the service-mail will use SMTP as transport
  smtp: {
    // SMTP host of the external email delivery service
    host: "smtp.ethereal.email",
    // SMTP port
    port: 587,
    // Credentials to authenticate against SMTP server
    auth: {
      user: "btvryvs5al5mjpa3@ethereal.email",
      pass: "VfNxJctkjrURkyThZr"
    }
  },
  // Alternative transport, using the sendmail command of the machine
  sendmail: {
    // Will replace SMTP transport if set to true
    active: false,
    // Path of the sendmail command on the machine
    path: '/usr/sbin/sendmail'
  },
  http: {
    // IP address on which the mailing server is listening
    ip: "127.0.0.1",
    // Port on which the mailing server is listening
    port: 9000,
    // Each sendmail request should contain authorization header that
    // matches this key, used to prevent abuse.
    auth: "CHANGEME",
  },
  templates: {
    // Root folder where the templates are stored
    root: '/templates/',
    // Default language for templates
    defaultLang: 'en'
  }
}
```

## Contribute

| Task                              | Command                         |
| --------------------------------- | ------------------------------- |
| Run the server                    | `yarn start`                    |
| Run the server with custom config | `yarn start --config conf.json` |

# License
Copyright (c) 2020 Pryv S.A. https://pryv.com

This file is part of Open-Pryv.io and released under BSD-Clause-3 License

Redistribution and use in source and binary forms, with or without 
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, 
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, 
   this list of conditions and the following disclaimer in the documentation 
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors 
   may be used to endorse or promote products derived from this software 
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

SPDX-License-Identifier: BSD-3-Clause
