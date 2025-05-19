# Build your own docker images

This guide explains how to build your own docker Open Pryv.io docker images.

*Prerequisites*:

- [Docker v19.03](https://docs.docker.com/engine/install/)
- [Docker-compose v1.26](https://docs.docker.com/compose/install/)


From `./docker/` folder

1. Make the images

  Run `docker compose --env-file src/env_config -f docker-compose-build.yml build`

2. Prepare the various assets

  - `bash ../scripts/setup-app-web-auth3`
  - `bash ../scripts/setup-assets`

3. Pack the base directory 

  This will pack in `dockerized-open-pryv-${PRYV_TAG}` the content of `./src` , the config files in `../configs/` an `../public.html` in `dockerized-open-pryv-${PRYV_TAG}.tgz`

  **Warning** the configuration files will be packaged make sure that adminKeys are not set if your intent is to publish it. 

  run `./build-tarball.sh`