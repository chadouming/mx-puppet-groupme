FROM node:16-alpine AS builder

WORKDIR /opt/mx-puppet-groupme

RUN apk add --no-cache \
        python3 \
        g++ \
        build-base \
        cairo-dev \
        jpeg-dev \
        pango-dev \
        musl-dev \
        giflib-dev \
        pixman-dev \
        pangomm-dev \
        libjpeg-turbo-dev \
        freetype-dev

# run build process as user in case of npm pre hooks
# pre hooks are not executed while running as root

COPY . .
RUN chown -R node:node /opt/mx-puppet-groupme
USER node
RUN npm install
RUN npm run build


FROM node:alpine

VOLUME /data

ENV CONFIG_PATH=/data/config.yaml \
    REGISTRATION_PATH=/data/groupme-registration.yaml

# su-exec is used by docker-run.sh to drop privileges
RUN apk add --no-cache su-exec pixman cairo pango giflib libjpeg

WORKDIR /opt/mx-puppet-groupme
COPY docker-run.sh ./
COPY --from=builder /opt/mx-puppet-groupme/ .
RUN chmod +x docker-run.sh

# change workdir to /data so relative paths in the config.yaml
# point to the persistent volume
WORKDIR /data
ENTRYPOINT ["/opt/mx-puppet-groupme/docker-run.sh"]
