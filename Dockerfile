FROM node:24.21.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server.js LICENSE.md ./
COPY public/ public/
EXPOSE 3457
USER node
CMD ["node", "server.js"]
