FROM node:20-alpine

WORKDIR /app

# Install shared library
COPY shared/ /app/shared/
RUN cd /app/shared && npm install --production

# Install service dependencies
COPY push-gateway/package.json /app/service/package.json
WORKDIR /app/service
RUN npm install --production

# Copy service source
COPY push-gateway/ /app/service/

# MF1 deployment-identity.
ARG COMMIT_SHA
ARG BUILD_TIMESTAMP
ENV COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

EXPOSE 8103
CMD ["node", "server.js"]
