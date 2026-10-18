FROM node:24-slim AS deps
WORKDIR /app
# Manifest first so the dependency layer is cached until package*.json change.
# three is served at runtime from node_modules, so it must be in the prod install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
# Links the GHCR package to this repo (and inherits its visibility/access).
LABEL org.opencontainers.image.source="https://github.com/bubthegreat/pea-shooter-zombies"
ENV NODE_ENV=production
WORKDIR /app
# package.json carries "type": "module"; node needs it next to server/ to load the ESM entrypoint.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
COPY client ./client

# The node user is uid/gid 1000 (matches the pod securityContext).
USER 1000
EXPOSE 8080
CMD ["node", "server/index.js"]
