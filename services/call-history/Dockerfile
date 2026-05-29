FROM node:22-alpine

WORKDIR /app

# Install shared library. Build context is ./services (see docker-compose.yml),
# so shared/ and call-history/ are both reachable as top-level paths — do NOT
# use ../shared (that escapes the context and fails the build).
COPY shared/ /app/shared/
RUN cd /app/shared && npm install --production

# Install service dependencies. The package.json lives at
# ./services/call-history/package.json relative to the context, NOT at the
# context root — the original `COPY package*.json ./service/` looked for
# ./services/package.json (absent) and broke every build since 2026-03-31.
COPY call-history/package.json /app/service/package.json
WORKDIR /app/service
RUN npm install --production

# Copy service source
COPY call-history/ /app/service/

# MF1 deployment-identity — surfaced via GET /version (createVersionHandler).
# compose passes COMMIT_SHA + BUILD_TIMESTAMP through build.args.
ARG COMMIT_SHA
ARG BUILD_TIMESTAMP
ENV COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

EXPOSE 8108
CMD ["node", "server.js"]
