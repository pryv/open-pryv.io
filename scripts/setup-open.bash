#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER

bash ./setup-assets.bash
bash ./setup-service-mail.bash
bash ./setup-app-web-auth3.bash
bash ./setup-admin-key.bash
bash ./download-recla-certificates.sh