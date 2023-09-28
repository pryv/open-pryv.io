#!/bin/bash

# quit if fail
set -e

if ! [ -x "$(command -v docker-compose)" ]; then
  echo 'Error: docker-compose is not installed.' >&2
  exit 1
fi

# =====================================================================
# ================= Create folders with not root rights================
# =====================================================================
if [ ! -d "var-pryv/mongodb" ]; then `mkdir -p var-pryv/mongodb`; fi
if [ ! -d "var-pryv/logs" ]; then `mkdir -p var-pryv/logs`; fi

# =====================================================================
# ================= Download authentication frontend ==================
# =====================================================================
# download git dependencies (so there would be no need to github authentication inside docker container)

APP_WEB_AUTH_FOLDER="app-web-auth3"
if [ ! -d $APP_WEB_AUTH_FOLDER ]; then
  git clone --depth=1 --branch=master https://github.com/pryv/app-web-auth3.git $APP_WEB_AUTH_FOLDER
fi

# =====================================================================
# ================= Setup assets to public_html/assets/================
# ================= like registration button style and etc=============
# =====================================================================

bash ../scripts/setup-assets

# =====================================================================
# ================= Config parsing starts         =====================
# =====================================================================
jsonval () {
	temp=`echo $1 | sed 's/\\\\\//\//g' | sed 's/[{}]//g' | awk -v k="text" '{n=split($0,a,","); for (i=1; i<=n; i++) print a[i]}' | sed 's/\"\:\"/\|/g' | sed 's/[\,]/ /g' | sed 's/\"//g' | grep -w $2`
	# | sed -e 's/^ *//g' -e 's/ *$//g
	temp=${temp##*|}
  echo "$temp"
}
CONFIGS_FILE="local/dockerized-config.yml"
JSON_CONF=$(cat $CONFIGS_FILE)
PUBLIC_URL_ROW=$(jsonval "$JSON_CONF" "publicUrl")
HOSTNAME=$(echo $PUBLIC_URL_ROW | cut -d"/" -f3)
echo "Public URL is $PUBLIC_URL_ROW"
echo "Hostname is $HOSTNAME"

# =====================================================================
# ================= Config parsing ends           =====================
# =====================================================================

# download or update rec.la domain certificates
bash ../scripts/update-recla-certificates

# =====================================================================
# ================= Start docker compose          =====================
# =====================================================================

DOCKER_COMPOSE_FILE=$1
DOCKER_COMMAND=$2
PORT=80
PORT_SSL=4443
if [ -z "$DOCKER_COMPOSE_FILE" ]
then
    echo "No docker compose file was given so starting default with ./local/docker-compose.no-ssl.yml"
    HOSTNAME=$HOSTNAME TAG=latest docker-compose -f local/docker-compose.no-ssl.yml up --build
else
    if [ -z "$DOCKER_COMMAND" ]
    then
        echo "Running: HOSTNAME=$HOSTNAME TAG=latest docker-compose -f $DOCKER_COMPOSE_FILE up --build"
        HOSTNAME=$HOSTNAME TAG=latest docker-compose -f $DOCKER_COMPOSE_FILE up --build
    else
        echo "Running: HOSTNAME=$HOSTNAME TAG=latest docker-compose -f $DOCKER_COMPOSE_FILE $DOCKER_COMMAND"
        HOSTNAME=$HOSTNAME TAG=latest docker-compose -f $DOCKER_COMPOSE_FILE $DOCKER_COMMAND
    fi
fi
