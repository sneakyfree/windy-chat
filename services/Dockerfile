FROM node:20-alpine

ARG SERVICE_DIR
WORKDIR /app

# Copy shared modules and install their deps
COPY shared/ /app/shared/
RUN cd /app/shared && npm install --production

# Copy service package.json and install deps
COPY ${SERVICE_DIR}/package.json /app/service/package.json
WORKDIR /app/service
RUN npm install --production

# Copy service source
COPY ${SERVICE_DIR}/ /app/service/

EXPOSE 8080
CMD ["node", "server.js"]
