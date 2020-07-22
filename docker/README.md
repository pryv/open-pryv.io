# Dockerized Open Pryv.io

This archive contains the necessary files to download and run Open Pryv.io.

*Prerequisites*:

- [Docker v19.03](https://docs.docker.com/engine/install/)
- [Docker-compose v1.26](https://docs.docker.com/compose/install/)

## Local dev with SSL

1. Edit the following value in the [Config](https://github.com/pryv/open-pryv.io#config) file `local/dockerized-config.json`:
   - auth:adminAccessKey: secret for admin functions, change it from its default value otherwise Open Pryv.io will crash on boot.

2. Run:

```bash
docker-compose -f local/docker-compose.with-ssl.yml up
```

It will run Open Pryv.io on https://my-computer.rec.la:4443, using [rec-la](https://github.com/pryv/rec-la).

## Server with built-in SSL

1. Edit the following values in the [Config](https://github.com/pryv/open-pryv.io#config) file `production-with-ssl/dockerized-config.json` and docker-compose file: `production-with-ssl/docker-compose.yml`:

   - ${HOSTNAME}: the hostname part of the public URL
   - auth:adminAccessKey: secret for admin functions, change it from its default value otherwise Open Pryv.io will crash on boot.

2. Run:

```bash
docker-compose -f production-with-ssl/docker-compose.yml up
```

It will run Open Pryv.io on https://${HOSTNAME}.

## Server with external SSL

1. Edit the following value in the [Config](https://github.com/pryv/open-pryv.io#config) file `production-no-ssl/dockerized-config.json`:
   - ${HOSTNAME}: the hostname part of the public URL
   - auth:adminAccessKey: secret for admin functions, change it from its default value otherwise Open Pryv.io will crash on boot.

2. Run:

```bash
docker-compose -f production-no-ssl/docker-compose.yml up
```

It will run Open Pryv.io on http://0.0.0.0:3000. However, all [service information](https://api.pryv.com/reference/#service-info) resources will be advertised on https://${HOSTNAME}.
