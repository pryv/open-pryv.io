#!/bin/bash

# Sets up the dev environment on a 64-bit OSX or GNU/Linux system.
# Re-run to update e.g. the node version (from the new default) or the JSHint config (from the master).

# working dir fix
SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/.. # root


## used in Open Pryv
SCRIPT_EXTRAS="./scripts/setup-open.bash"
if [[ -f $SCRIPT_EXTRAS ]]; then
  echo "installing service mail"
  bash $SCRIPT_EXTRAS
fi

echo ""
echo "Setup complete!"
echo ""

export DATA_FOLDER=$SCRIPT_FOLDER/../var-pryv
export LOGS_FOLDER=${DATA_FOLDER}/logs
export ATTACHMENTS_FOLDER=${DATA_FOLDER}/attachment-files

export MONGO_BASE_FOLDER=$DATA_FOLDER

# file structure

mkdir -p $DATA_FOLDER
mkdir -p $LOGS_FOLDER
mkdir -p $ATTACHMENTS_FOLDER

# database

. scripts/setup-mongodb.bash
EXIT_CODE=$?
if [[ ${EXIT_CODE} -ne 0 ]]; then
  echo ""
  echo "Error setting up database; setup aborted"
  echo ""
  exit ${EXIT_CODE}
fi
