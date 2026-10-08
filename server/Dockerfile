FROM node:22.23.3-alpine3.24

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node index.js ./index.js
COPY --chown=node:node server-core.js ./server-core.js
COPY --chown=node:node public/ ./public/
COPY --chown=node:node updates/ ./updates/

USER node

EXPOSE 3000 3010

CMD ["node", "index.js"]
