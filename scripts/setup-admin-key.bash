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
sed -i ".bak" "s/${DEFAULT_VALUE}/${rand}/g" "./config.yml"
sed -i ".bak" "s/${DEFAULT_VALUE}/${rand}/g" "./configs/rec-la.yml"
sed -i ".bak" "s/${DEFAULT_VALUE}/${rand}/g" "./docker/local/dockerized-config.yml"
sed -i ".bak" "s/${DEFAULT_VALUE}/${rand}/g" "./docker/local/dockerized-config-no-ssl.yml"

rm "./config.yml.bak"
rm "./configs/rec-la.yml.bak"
rm "./docker/local/dockerized-config.yml.bak"
rm "./docker/local/dockerized-config-no-ssl.yml.bak"

echo "Set new random key for admin"

