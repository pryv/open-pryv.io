#!/bin/sh

# working dir fix
SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/..

export VAR_PRYV_FOLDER=$SCRIPT_FOLDER/../var-pryv
rsync --recursive --times --human-readable --verbose --perms $1 ${VAR_PRYV_FOLDER}/attachment-files/

