#!/bin/sh

# working dir
PARENT_DIR=$(pwd)
cd "${PARENT_DIR}"
echo "Parent dir: ${PARENT_DIR}"

# build backup directory
BACKUP_DIR=$(echo $1 | sed 's:/*$::');
echo "Backup dir: ${BACKUP_DIR}"

export VAR_PRYV_FOLDER="${PARENT_DIR}/var-pryv"

rsync --recursive --times --human-readable --verbose --perms "${VAR_PRYV_FOLDER}/attachment-files/" $BACKUP_DIR