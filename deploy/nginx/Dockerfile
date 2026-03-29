FROM nginx:1.25-alpine

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy Windy Chat nginx config
COPY synapse/nginx.conf /etc/nginx/conf.d/windy-chat.conf

EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
