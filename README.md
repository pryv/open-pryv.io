# Open Pryv.io

![Pryv-Logo](https://i0.wp.com/pryv.com/wp-content/uploads/2018/06/logo-data-privacy-management-pryv.png?fit=256%2C100&ssl=1)

**Personal Data & Privacy Management Software**

A ready-to-use solution for personal data and consent management.

Pryv.io is a solid foundation on which you build your own digital health solution, so you can collect, store, share and rightfully use personal data.

Maintained and developed by Pryv.

![Solution](readme/pryv.io-ecosystem.jpg)

## Features

- Provides latest Pryv.io core system ready for production
- User registration and authentication
- Granular consent-based access control rights
- Data model made for privacy, aggregation and sharing [Data in Pryv](https://pryv.com/data_in_pryv/)
- Full data life-cycle: collect - store - change - delete
- REST & Socket.io API
- Ease of software integration and configuration
- Seamless connectivity and interoperability

## Documentation

- API Documentation & Guides: [api.pryv.com](https://api.pryv.com)
- Support: [support.pryv.com](https://support.pryv.com)
- More information about Pryv : [Pryv Home](https://pryv.com)

## Summary

1. Choose your setup
2. Download the required files / Run the installation scripts
3. Edit the configuration files
4. Start the services
5. Try the API
6. Customize your platform

## Setup

Pryv.io is designed to be exposed by a third party SSL termination such as NGINX.

Choose your Set-up

- Discover Open Pryv.io on your local environment, this will only allow localhost apps to connect to your platform.
  - Download docker images without SSL (quick start)
  - Download docker images with SSL
  - Native installation
- Launch Pryv.io on a server exposed to the Internet with built-in SSL, this requires to have a hostname pointing to the public IP of your server.
  - Download docker images (quick start)
  - Native installation
- Launch Pryv.io on a server with an external SSL termination. You know what you are doing.
  - Download docker images
  - Native installation

### Docker

The dockerized versions are available at this link: [Download link](docker/dockerized-open-pryv.io.tgz?raw=true).

If you wish to build the images yourself, refer to the following README: [docker/README-build.md](docker/README-build.md).

Once it is running, you can continue with the [tutorials](#dockerized).

### Native

*Prerequisites*:

- Node v12.13.1 [Node.js home page](https://nodejs.org/)
- Yarn v1 `npm install -g yarn`

The installation script has been tested on Linux Ubuntu 18.04 LTS and MacOSX.

- `yarn setup`: (see `scripts/` for details)
  - Fetch dependencies
  - Install mongodb
  - Install service mail
  - Install assets & app-web-auth3
  - Generate random alpha-numeric adminKey
- `yarn release` create distribution for release

#### Native setup with external SSL

[setup the environment](#native)

- `yarn pryv` - mail and database logs will be kept in `var-pryv/logs/local-*.log`

Each service independently - logs will be displayed on the console

- `yarn database` start mongodb
- `yarn api` start the API server on port 3000 (default)
- `yarn mail` start the mail service

#### Local native setup

[setup the environment](#native)

- `yarn local` is the equivalent of running `yarn pryv` + `yarn proxy` using `configs/rec-la.json`. This setup is useful to test Open Pryv.io locally.

- `yarn proxy` based on [rec-la](https://github.com/pryv/rec-la), it will expose the server running on http://localhost:3000 with an SSL certificate on https://my-computer.rec.la:4443 in this case you need to edit `configs/rec-la.json`.

#### Native Server setup with built-in SSL

[setup the environment](#native)

1. Run `yarn pryv` to start the API
2. Configure NGINX and certificate

You can find a NGINX configuration that you can include in your `sites-enabled/` in [configs/site.conf](configs/site.conf).

You must change `${HOSTNAME}` to match the hostname of the public URL.

##### SSL certificate

Using [certbot](https://certbot.eff.org/), you can generate a SSL certificate for your platform using `sudo certbot --nginx -d ${HOSTNAME}`.

To set an automatic renewal, run `crontab -e` and append the following line:

```cron
0 12 * * * /usr/bin/certbot renew --quiet
```

### Config

For the native installation, edit `config.json`, otherwise `local/dockerized-config.json`:

```json
{
  "dnsLess": {
    "publicUrl":  "http://localhost:3000"
  },
  "http": {
    "port": 3000,
    "ip": "127.0.0.1"
  },
  "auth": {
    "adminAccessKey": "replace_me_randomstring",
    "trustedApps": "*@https://pryv.github.io, *@https://*.rec.la*"
  },
  "eventFiles": {
    "attachmentsDirPath": "var-pryv/attachment-files"
  },
  "service": {
    "name": "Test",
    "support": "https://pryv.com/openpryv/unconfigured.html",
    "terms": "https://pryv.com/openpryv/unconfigured.html",
    "home": "https://pryv.com/openpryv/unconfigured.html",
    "eventTypes": "https://api.pryv.com/event-types/flat.json",
    "assets": {
      "definitions": "http://localhost:3000/www/assets/index.json"
    }
  },
  "services": {
    "email": {
      "enabled": {
        "welcome": true,
        "resetPassword": true
      }
    }
  }
}
```

- **publicUrl** Is the "Public" URL to reach the service, usually exposed in **https** by a third party SSL service such as NGNIX.
- **http**
  - **port** The local port to listen
  - **ip** The IP adress to use. Keep it 127.0.0.1 unless you explicitely want to expose the service in `http` to another network.
- **auth**
  - **adminAccesskey** key to use for system calls such as `/reg/admin/users`. A random key should be generated on setup.
  - **trustedApps** list of web apps that can be trusted-app functionalities
     API for trusted apps: [API reference](https://api.pryv.com/reference/)
    see: [SETUP Guide - customize authentication](https://api.pryv.com/customer-resources/pryv.io-setup/#customize-authentication-registration-and-reset-password-apps)
- **eventFiles**
  - **attachmentsDirPath** Directory where event attachment files will be stored on the file system.
- **service** [API documentation on Service Information](https://api.pryv.com/reference/#service-info)
- **services:email** see [Options & Customization](#custom-email) below

## Start

At this moment you should have your application running on the public URL you defined.

### Native

- Create an account and launch the [authentication process](https://api.pryv.com/reference/#authenticate-your-app) on **App-Web-Access**: [https://api.pryv.com/app-web-access/?pryvServiceInfoUrl=https://my-computer.rec.la:4443/reg/service/info](https://api.pryv.com/app-web-access/?pryvServiceInfoUrl=https://my-computer.rec.la:4443/reg/service/info).
- The service info URL to your platform is: [https://my-computer.rec.la:4443/reg/service/info](https://my-computer.rec.la:4443/reg/service/info)

If you are using another public URL, replace `https://my-computer.rec.la:4443` by it in the link above.

### Dockerized

- Create an account and launch the [authentication process](https://api.pryv.com/reference/#authenticate-your-app) on **App-Web-Access**: [https://api.pryv.com/app-web-access/?pryvServiceInfoUrl=https://my-computer.rec.la:4443/reg/service/info](https://api.pryv.com/app-web-access/?pryvServiceInfoUrl=https://my-computer.rec.la:4443/reg/service/info).
- The service info URL to your platform is: [https://my-computer.rec.la:4443/reg/service/info](https://my-computer.rec.la:4443/reg/service/info)

If you are using another public URL, replace `https://my-computer.rec.la:4443` by it in the link above.

### Try the API

After this process, you should have an account on your Open Pryv.io platform with a valid authorization token in the form of an API endpoint, you can try various **API requests** using **Postman** following this guide [https://api.pryv.com/open-api/](https://api.pryv.com/open-api/).

You can also try our [example apps with guides and tutorials](https://github.com/pryv/app-web-examples/).

## Options & Customization

### Authentication & Registration web app.

Open Pryv.io comes packaged with [app-web-auth3](https://github.com/pryv/app-web-auth3), the default web pages for app authentication, user registration and password reset.

During the set-up process it has been built and published in `public_html/access/`. To customize it, refer to its `README` in `app-web-auth3/`.

To use a new build, simply copy the contents of the generated files from `app-web-auth3/dist/` to `public_html/access/`

### Visual assets and icons

Your platforms visuals can be customized in `public_html/assets/`, please refer to the README inside. These assets are a clone of the [assets-open-pryv.io](https://github.com/pryv/assets-open-pryv.io).

### E-Mails<a name="custom-email"></a>

Pryv.io can send e-mails at registration and password reset request.

The emails can be sent either by local sendmail (default) or SMTP. 

This service, its documentation and mail templates can be found in [`service-mail/`](service-mail/).

## Contributing

Open Pryv.io is developed and maintained by Pryv's team. You may contact us to submit a change or adaptation but do not be offended if we decline it or decide to re-write it.

## License

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
