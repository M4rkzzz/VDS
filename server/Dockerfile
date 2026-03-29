FROM node:22-alpine

WORKDIR /app

COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
RUN npm ci --omit=dev

COPY index.js ./index.js
COPY server-core.js ./server-core.js
COPY public/ ./public/
COPY updates/ ./updates/

EXPOSE 3000

CMD ["node", "index.js"]
