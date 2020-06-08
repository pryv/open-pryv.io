#!/bin/sh

# working dir fix
SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/..

export MONGO_BASE_FOLDER=$SCRIPT_FOLDER/../var-pryv
export MONGO_DATA_FOLDER=$MONGO_BASE_FOLDER/mongodb-data

${MONGO_BASE_FOLDER}/mongodb-bin/bin/mongod --dbpath ${MONGO_DATA_FOLDER}

