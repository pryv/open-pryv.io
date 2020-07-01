#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/.. # root


# Set up app-web-auth3
APP_WEB_AUTH_FOLDER="app-web-auth3"
if [[ ! -d $APP_WEB_AUTH_FOLDER ]]; then
  git clone --depth=1 --branch=master https://github.com/pryv/app-web-auth3.git $APP_WEB_AUTH_FOLDER

  cd $APP_WEB_AUTH_FOLDER
  rm -rf .git
  echo "module.exports = {DNSLess: true};" > "./src/defaults.js"
  yarn setup
  yarn build
  mv ./dist/* ../public_html/
  echo "App-web-auth3 fetched out in ${APP_WEB_AUTH_FOLDER}"
else
  echo "App-web-auth3 already fetched skipping"
fi
