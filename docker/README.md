# Dockerized Open Pryv.io

This archive contains the necessary files to download and run Open Pryv.io.

*Prerequisites*:

- [Docker v19.03](https://docs.docker.com/engine/install/)
- [Docker-compose v1.26](https://docs.docker.com/compose/install/)
- [Yarn v1.22.4](https://classic.yarnpkg.com/en/docs/install/)
- Rsync (for Backup and restore only)

## Local dev with SSL

1. Edit the following value in the [Config](https://github.com/pryv/open-pryv.io#config) file `local/dockerized-config.yml`:
   - auth:adminAccessKey: secret for admin functions, change it from its default value otherwise Open Pryv.io will crash on boot.

2. Run:

```bash
docker-compose -f local/docker-compose.with-ssl.yml up
```

It will run Open Pryv.io on https://my-computer.rec.la:4443, using [rec-la](https://github.com/pryv/rec-la).

## Server with built-in SSL

1. Edit the following values in the [Config](https://github.com/pryv/open-pryv.io#config) file `production-with-ssl/dockerized-config.yml` and docker-compose file: `production-with-ssl/docker-compose.yml`:

   - ${HOSTNAME}: the hostname part of the public URL
   - auth:adminAccessKey: secret for admin functions, change it from its default value otherwise Open Pryv.io will crash on boot.

2. Run:

```bash
docker-compose -f production-with-ssl/docker-compose.yml up
```

It will run Open Pryv.io on https://${HOSTNAME}.

## Server with external SSL

1. Edit the following value in the [Config](https://github.com/pryv/open-pryv.io#config) file `production-no-ssl/dockerized-config.yml`:
   - ${HOSTNAME}: the hostname part of the public URL
   - auth:adminAccessKey: secret for admin functions, change it from its default value otherwise Open Pryv.io will crash on boot.

2. Run:

```bash
docker-compose -f production-no-ssl/docker-compose.yml up
```

It will run Open Pryv.io on http://0.0.0.0:3000. However, all [service information](https://api.pryv.com/reference/#service-info) resources will be advertised on https://${HOSTNAME}.

## Backup

Run `./scripts/backup-database-docker.sh` to generate a dump of the current database contents in `var-pryv/backup/`.  
Run `./scripts/backup-attachments-docker.sh ${BACKUP_FOLDER}` to copy the current attachment files.
Depending on your setup, you may need additional access rights.

## Restore

Run `./scripts/restore-database-docker.sh` to restore data from `var-pryv/backup/`.  
Run `./scripts/restore-attachments-docker.sh ${BACKUP_FOLDER}` to restore attachments data from the provided backup folder.
Depending on your setup, you may need additional access rights.
# License
Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 

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