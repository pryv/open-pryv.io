FROM node:12

WORKDIR /app

# Copy all files
COPY . /app/

RUN apt-get update -y 
# install rsync needed for copying files to dist folder
RUN apt-get -y install rsync sendmail

RUN yarn setup
RUN yarn release

RUN apt-get install nano

EXPOSE 3000
EXPOSE 9000

# Start mail service
CMD ["yarn", "api"]
