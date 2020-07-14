#!/bin/bash

# quit if fail
set -e

if ! [ -x "$(command -v docker-compose)" ]; then
  echo 'Error: docker-compose is not installed.' >&2
  exit 1
fi

# =====================================================================
# ================= Config parsing starts         =====================
# =====================================================================
function jsonval {
	temp=`echo $1 | sed 's/\\\\\//\//g' | sed 's/[{}]//g' | awk -v k="text" '{n=split($0,a,","); for (i=1; i<=n; i++) print a[i]}' | sed 's/\"\:\"/\|/g' | sed 's/[\,]/ /g' | sed 's/\"//g' | grep -w $2`
	# | sed -e 's/^ *//g' -e 's/ *$//g
	temp=${temp##*|}
	# remove double quotes
  temp="${temp//\"}"
  # remove single quotes
  temp="${temp//\'}"
  echo "$temp"
}
#dockerized-config.json | getJsonVal "['text']"
JSON_CONF=$(cat "dockerized-config.json")
PUBLIC_URL_ROW=$(jsonval "$JSON_CONF" "publicUrl")
HOSTNAME=$(echo $PUBLIC_URL_ROW | cut -d"/" -f3)
EMAIL=$(echo $(jsonval "$JSON_CONF" "ssl_email") | cut -d":" -f2)

echo "PUBLIC_URL: $PUBLIC_URL_ROW (expecting format https://example.com)"
echo "HOSTNAME: $HOSTNAME  (expecting format example.com)"
echo "EMAIL: $EMAIL (expecting valid email with the same domain)"

# =====================================================================
# ================= Config parsing ends           =====================
# =====================================================================

HOSTNAME=$HOSTNAME EMAIL=$EMAIL docker-compose -f docker-compose.yml up
