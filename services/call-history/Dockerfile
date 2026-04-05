FROM node:22-alpine
WORKDIR /app
COPY ../shared/ /app/shared/
RUN cd /app/shared && npm install --production 2>/dev/null || true
COPY package*.json ./service/
WORKDIR /app/service
RUN npm install --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
