FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server/server.js"]
