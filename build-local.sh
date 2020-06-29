#!/usr/bin/env sh

# quit if fail
set -e

if [ ! -d "var-pryv" ]; then `mkdir -p var-pryv`; fi
if [ ! -d "var-pryv/mongodb" ]; then `mkdir -p var-pryv/mongodb`; fi
if [ ! -d "var-pryv/logs" ]; then `mkdir -p var-pryv/logs`; fi
if [ ! -d "dist" ]; then `mkdir -p dist`; fi

# download git dependencies (so there would be no need to github authentication inside docker container)
APP_WEB_AUTH_FOLDER="app-web-auth3"
if [[ ! -d $APP_WEB_AUTH_FOLDER ]]; then
  git clone --depth=1 --branch=master https://github.com/pryv/app-web-auth3.git $APP_WEB_AUTH_FOLDER
fi

# setup assets
bash ./scripts/setup-assets.bash
yarn install --ignore-optionals

docker-compose up --build
