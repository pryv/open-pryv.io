#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER

. ./src/env_config

TEMPDEST=./dockerized-open-pryv
rm -rf $TEMPDEST
mkdir -p $TEMPDEST
cp -r ./src/* $TEMPDEST/

cp -r ../configs $TEMPDEST
cp -r ../public_html $TEMPDEST
mkdir -p $TEMPDEST/var-pryv
mkdir -p $TEMPDEST/mail-logs
mkdir -p $TEMPDEST/var-pryv/mongo/backup
mkdir -p $TEMPDEST/var-pryv/mongo/db

DEST=dockerized-open-pryv-${PRYV_TAG}.tgz

tar -cvzf $DEST $TEMPDEST
rm -rf $TEMPDEST
echo "Docker base packed in ${DEST}"