#!/bin/bash

# This script updates the default event types JSON schema file,
# used as a fallback by the server for validating incoming event values.

SCHEMA_URL=https://api.pryv.com/event-types/flat.json
LOCAL_PATH=components/business/src/types/event-types.default.json

# working dir fix
SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/..

echo ""
echo "Downloading schema file from $SCHEMA_URL, saving to $LOCAL_PATH..."
echo ""

curl -L --fail -o $LOCAL_PATH $SCHEMA_URL
EXIT_CODE=$?

echo ""

exit ${EXIT_CODE}
