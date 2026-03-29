FROM node:20-alpine

WORKDIR /app

# Install shared library
COPY shared/ /app/shared/
RUN cd /app/shared && npm install --production

# Install service dependencies
COPY social/package.json /app/service/package.json
WORKDIR /app/service
RUN npm install --production

# Copy service source
COPY social/ /app/service/

EXPOSE 8105
CMD ["node", "server.js"]
