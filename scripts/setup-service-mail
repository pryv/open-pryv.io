#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/.. # root

# Sets up service-mail

SERVICE_MAIL_FOLDER="service-mail"

if [[ ! -d "${SERVICE_MAIL_FOLDER}/node_modules" ]]; then
  yarn --cwd $SERVICE_MAIL_FOLDER install
  echo "Service-Mail Installed!"
else
  echo "Service-Mail already installed skipping"
fi
