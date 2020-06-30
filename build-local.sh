#!/usr/bin/env sh

# quit if fail
set -e

if [ ! -d "var-pryv/mongodb" ]; then `mkdir -p var-pryv/mongodb`; fi
if [ ! -d "var-pryv/logs" ]; then `mkdir -p var-pryv/logs`; fi

# download git dependencies (so there would be no need to github authentication inside docker container)
APP_WEB_AUTH_FOLDER="app-web-auth3"
if [[ ! -d $APP_WEB_AUTH_FOLDER ]]; then
  git clone --depth=1 --branch=master https://github.com/pryv/app-web-auth3.git $APP_WEB_AUTH_FOLDER
fi

# setup assets
bash ./scripts/setup-assets.bash

# download rec.la certificates
CERTIFICATED_FOLDER="configs/rec.la-certificates"
if [[ ! -d $CERTIFICATED_FOLDER ]]; then
    git clone --branch=master https://github.com/pryv/rec-la.git $CERTIFICATED_FOLDER
else
    CURRENT_DIR=$(pwd)
    cd $CERTIFICATED_FOLDER # go to the certificates folder
    echo $(pwd)
    # download the newest version
    git pull
    # come back to the main dir
    cd $CURRENT_DIR
fi

DOCKER_COMPOSE_FILE=$1
if [ -z "$DOCKER_COMPOSE_FILE" ]
then
    docker-compose up --build
else
    docker-compose -f $DOCKER_COMPOSE_FILE up --build
fi
