FROM node:20-alpine

WORKDIR /app

# Install shared library
COPY shared/ /app/shared/
RUN cd /app/shared && npm install --production

# Install service dependencies
COPY onboarding/package.json /app/service/package.json
WORKDIR /app/service
RUN npm install --production

# Copy service source
COPY onboarding/ /app/service/

# MF1 deployment-identity — surfaced via GET /version per the marathon
# foundations contract. Build with --build-arg COMMIT_SHA=$(git rev-parse HEAD)
# --build-arg BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ); compose passes
# both through the service's build.args block.
ARG COMMIT_SHA
ARG BUILD_TIMESTAMP
ENV COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

EXPOSE 8101
CMD ["node", "server.js"]
