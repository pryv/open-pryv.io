#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/.. # root

set="abcdefghijklmonpqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
n=20
rand="REPLACE_ME_"
DEFAULT_VALUE="REPLACE_ME"
for i in `seq 1 $n`; do
    char=${set:$RANDOM % ${#set}:1}
    rand+=$char
done
sed -i ".bak" "s/${DEFAULT_VALUE}/${rand}/g" "./config.json"
sed -i ".bak" "s/${DEFAULT_VALUE}/${rand}/g" "./configs/rec-la.json"
sed -i ".bak" "s/${DEFAULT_VALUE}/${rand}/g" "./docker/local/dockerized-config.json"
sed -i ".bak" "s/${DEFAULT_VALUE}/${rand}/g" "./docker/local/dockerized-config-no-ssl.json"

rm "./config.json.bak"
rm "./configs/rec-la.json.bak"
rm "./docker/local/dockerized-config.json.bak"
rm "./docker/local/dockerized-config-no-ssl.json.bak"

echo "Set new random key for admin"

