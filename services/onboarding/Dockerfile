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

EXPOSE 8101
CMD ["node", "server.js"]
