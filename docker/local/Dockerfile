FROM node:16

WORKDIR /app

# Copy all files
COPY . /app/

# Choose dockerized config instead of default local env
COPY ./docker/local/dockerized-config.yml /app/config.yml
# the same for mail service
COPY ./docker/local/dockerized-service-mail-config.hjson /app/service-mail/config.json

RUN apt-get update -y 
# install rsync needed for copying files to dist folder
RUN apt-get -y install rsync sendmail && yes "Y" | /usr/sbin/sendmailconfig

RUN echo 'echo "$(tail -n 1 /etc/hosts) localhost localhost.localdomain $HOSTNAME" >> /etc/hosts' > /app/mail.sh
RUN echo 'yes "Y" | /usr/sbin/sendmailconfig' >> /app/mail.sh
RUN echo 'yarn mail' >> /app/mail.sh
RUN yarn setup && yarn release

RUN apt-get install nano

EXPOSE 3000
EXPOSE 9000

