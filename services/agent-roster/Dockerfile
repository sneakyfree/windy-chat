FROM node:20-alpine

# python3 + build-base needed for better-sqlite3 native build
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Shared modules (admin-telemetry) — same layout as onboarding/directory:
# /app/shared next to /app/service so `require('../../shared/<mod>')`
# resolves from lib/.
COPY shared/ /app/shared/

# Install agent-roster dependencies
COPY agent-roster/package.json /app/service/package.json
WORKDIR /app/service
RUN npm install --production

# Copy service source
COPY agent-roster/ /app/service/

# MF1 deployment-identity
ARG COMMIT_SHA
ARG BUILD_TIMESTAMP
ENV COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

EXPOSE 8106
CMD ["node", "server.js"]
