# service-mail

Sends emails on behalf of a Pryv.io core for user password reset and welcome emails.


## Usage

### API: `POST /sendmail/:template/:lang`

Request the sending of an email, where:
- `:template` defines the type of email (e.g. welcome).
- `:lang` defines the language in which the email should be written.

Each request should contain the following body parameters:
- `substitutions`: a mapping of variables that will be substituted in the email (e.g. _{name: 'bob'}_)
- `to`: information about the recipient (in the form _{name: 'bob', email: 'bob@domain.com'}_)
- `key`: shared key used to authenticate the requesting service against the mail service


### Configuration

The service can be configured by providing a configuration file (JSON, HJSON or YAML) containing settings that we list and explain below.

#### Templates

Templates consist of [pug](https://pugjs.org/api/getting-started.html) files, arranged into folders according to email types and langage codes, see the [default templates](templates) for example.

The default root folder for templates is `templates/`, it can be configured with key `templates.root`.

If the template for requested language does not exist, the service will try to find another template for the same email type but with a default language (e.g. English instead of French). Default language can be defined in configuration with key `templates.defaultLang`.

#### Transport

The service allows to define two types of transport, SMTP or Sendmail command.

##### SMTP

SMTP transport is used by default, it allows to define an external mail delivery service through configuration:
- `smtp.host`: SMTP host (e.g. `smtp.ethereal.email`)
- `smtp.port`: SMTP port (e.g. `587`)
- `smtp.auth.user`, `smtp.auth.pass`: credentials to authenticate against an external mail service (e.g. sendgrid)

##### Sendmail

An alternative is to use the sendmail command of the machine on which service-mail is running.
It has to be explicitly activated through configuration:
- `sendmail.active`: true
- `sendmail.path`: path to the sendmail command on the machine

#### Other settings

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
        address: "youruser@ethereal.email"
      }
    },
    preview: false, // If true, it will open a webpage with a preview
    send: true // Activate/deactivate the actual sending (prod/test env)
  },
  // By default, service-mail will use SMTP as transport
  smtp: {
    // SMTP host of the external email delivery service
    host: "smtp.ethereal.email",
    // SMTP port
    port: 587,
    // Credentials to authenticate against SMTP server
    auth: {
      user: "youruser@ethereal.email",
      pass: "youkey"
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


## Contributing

### Todo 
- realease github workflow has been archived in `archives` it needs to rewritten to publish on dockerHub

### Installation

Prerequisites: [Node.js](https://nodejs.org/en/download/) 16, [just](https://github.com/casey/just#installation)

Then:
1. `just setup-dev-env`
2. `just install` to install node modules

Running `just` with no argument displays the available commands (defined in `justfile`).


### Testing

```
just test [...params]
```
- Extra parameters at the end are passed on to [Mocha](https://mochajs.org/) (default settings are defined in `.mocharc.js`)
- Replace `test` with `test-detailed`, `test-debug`, `test-cover` for common presets


## License

[BSD-3-Clause](LICENSE)


# License

[BSD-3-Clause](LICENSE)
