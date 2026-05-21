FROM node:20-alpine

# ffmpeg drives the thumbnail/transcode pipeline in services/media/lib/*.
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install shared library (build context is ./services per docker-compose.yml,
# so `shared/` resolves to services/shared and `media/` to services/media).
COPY shared/ /app/shared/
RUN cd /app/shared && npm install --production

# Install media service dependencies
COPY media/package.json /app/service/package.json
WORKDIR /app/service
RUN npm install --production

# Copy media service source
COPY media/ /app/service/

# MF1 deployment-identity.
ARG COMMIT_SHA
ARG BUILD_TIMESTAMP
ENV COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

EXPOSE 8107
CMD ["node", "server.js"]
