#!/bin/sh
SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER
docker compose --env-file env_config -f docker-compose.yml up --detach