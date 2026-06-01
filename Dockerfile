FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production --no-audit --no-fund
COPY server.js .
COPY public/ public/
# certs are mounted read-only at runtime, never baked into the image
EXPOSE 3457
USER node
CMD ["node", "server.js"]
