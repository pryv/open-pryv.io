FROM node:12

WORKDIR /app

# Copy all files
COPY . /app/

# Choose dockerized config instead of default local env
COPY ./configs/dockerized-config.json /app/config.json
# the same for mail service
COPY ./configs/dockerized-service-mail-config.hjson /app/service-mail/config.json

RUN apt-get update -y 
# install rsync needed for copying files to dist folder
RUN apt-get -y install rsync sendmail

RUN yarn setup
RUN yarn release

RUN apt-get install nano

EXPOSE 3000
EXPOSE 9000

