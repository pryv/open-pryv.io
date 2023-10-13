#!/bin/sh

# working dir fix
PARENT_DIR="$(pwd)"
cd "${PARENT_DIR}"

BACKUP_DIR=$(echo $1 | sed 's:/*$::')
BACKUP_DIR="${BACKUP_DIR}/"

export VAR_PRYV_FOLDER="${PARENT_DIR}/var-pryv"
rsync --recursive --times --human-readable --verbose --perms $BACKUP_DIR "${VAR_PRYV_FOLDER}/core/"