#!/bin/bash

# This script updates the default event types JSON schema file,
# used as a fallback by the server for validating incoming event values.

SCHEMA_URL=http://pryv.github.io/event-types/flat.json
LOCAL_PATH=src/schema/event-types.default.json

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
