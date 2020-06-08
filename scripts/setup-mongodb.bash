#!/bin/bash

# Sets up MongoDB (engine and data) for server app(s).
# Meant to be run from dev env setup scripts.

if [ `uname` = "Linux" ]; then
  export MONGO_NAME=mongodb-linux-x86_64-3.6.17
  export MONGO_DL_BASE_URL=https://fastdl.mongodb.org/linux
elif [ `uname` = "Darwin" ]; then # OSX
  export MONGO_NAME=mongodb-osx-ssl-x86_64-3.6.17
  export MONGO_DL_BASE_URL=https://fastdl.mongodb.org/osx
else
  echo "Installation is meant to be on Linux or OSX"
  exit 1
fi

export MONGO_DATA_FOLDER=$DATA_FOLDER/mongodb-data

if [[ -z "$MONGO_BASE_FOLDER" ]]; then
  echo ""
  echo "Expected environment variables:"
  echo "    MONGO_BASE_FOLDER Root installation folder; created if missing"
  echo ""
  echo "MongoDB will be installed (if needed) in \"MONGO_BASE_FOLDER/MONGO_NAME\""
  echo ""
  exit 1
fi

# working dir fix
SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/

mkdir -p $MONGO_BASE_FOLDER
mkdir -p $MONGO_DATA_FOLDER

if [[ ! -d $MONGO_BASE_FOLDER ]]; then
  echo ""
  echo "Invalid base folder path: '$MONGO_BASE_FOLDER' does not exist"
  echo ""
  exit 1
fi

if [[ ! -d $MONGO_DATA_FOLDER ]]; then
  echo ""
  echo "Invalid data folder path: '$MONGO_DATA_FOLDER' does not exist"
  echo ""
  exit 1
fi

echo ""
MONGO_FOLDER_NAME=mongodb-bin
echo "Checking for MongoDB ($MONGO_BASE_FOLDER/$MONGO_FOLDER_NAME)..."
if [[ ! -d $MONGO_BASE_FOLDER/$MONGO_FOLDER_NAME ]]; then
  echo "...installing $MONGO_NAME"
  echo ""
  EXIT_CODE=0
  curl -C - -o "$MONGO_BASE_FOLDER/$MONGO_NAME.tgz" $MONGO_DL_BASE_URL/$MONGO_NAME.tgz
  EXIT_CODE=`expr ${EXIT_CODE} + $?`
  cd $MONGO_BASE_FOLDER
  mkdir $MONGO_FOLDER_NAME
  tar -xzf $MONGO_NAME.tgz -C $MONGO_FOLDER_NAME --strip-components 1  # extract into standardized mongo folder name to be os-independant
  EXIT_CODE=`expr ${EXIT_CODE} + $?`
  rm $MONGO_NAME.tgz
  if [[ ${EXIT_CODE} -ne 0 ]]; then
    echo ""
    echo "Failed installing MongoDB. Setup aborted."
    echo ""
    exit $((${EXIT_CODE}))
  fi
else
  echo "...skipped: $MONGO_FOLDER_NAME already installed"
fi


echo ""
echo "Database setup complete."
echo ""
echo "To run MongoDB (--dbpath defaults to /data/db if not specified):"
echo "    $MONGO_BASE_FOLDER/$MONGO_NAME/bin/mongod --dbpath $MONGO_DATA_FOLDER [<other arguments>]"
echo ""
