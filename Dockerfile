FROM node:20-alpine AS builder

RUN apk update --no-cache && apk upgrade --no-cache

WORKDIR /workspace/app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime

RUN apk update --no-cache && apk upgrade --no-cache

WORKDIR /srv/plantuml-mcp-server

COPY --from=builder /workspace/app/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /workspace/app/dist ./dist
COPY --from=builder /workspace/app/documentation ./documentation
COPY --from=builder /workspace/app/README.md ./README.md

RUN addgroup -S mcp && adduser -S mcp -G mcp && \
    chown -R mcp:mcp /srv/plantuml-mcp-server

USER mcp

EXPOSE 8765

CMD ["node", "dist/plantuml-mcp-server.js"]
