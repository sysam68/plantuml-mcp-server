FROM node:20-alpine AS builder

ARG REPO_URL=https://github.com/sysam68/plantuml-mcp-server.git
ARG BRANCH=main

RUN apk update --no-cache && apk upgrade --no-cache && apk add --no-cache git

WORKDIR /workspace

RUN git clone --depth=1 --branch "${BRANCH}" "${REPO_URL}" app

WORKDIR /workspace/app

RUN npm ci && npm run build

FROM node:20-alpine AS runtime

#ENV NODE_ENV=production \
#    LOG_LEVEL=info \
#    MCP_TRANSPORT=sse \
#    MCP_HOST=0.0.0.0 \
#    MCP_PORT=8765 \
#    MCP_SSE_PATH=/sse \
#    MCP_SSE_MESSAGES_PATH=/messages \
#    PLANTUML_SERVER_URL=https://www.plantuml.com/plantuml

RUN apk update --no-cache && apk upgrade --no-cache

WORKDIR /srv/plantuml-mcp-server

COPY --from=builder /workspace/app/package*.json ./

RUN npm ci --omit=dev

COPY --from=builder /workspace/app/dist ./dist

RUN addgroup -S mcp && adduser -S mcp -G mcp && \
    chown -R mcp:mcp /srv/plantuml-mcp-server

USER mcp

EXPOSE 8765

CMD ["node", "dist/plantuml-mcp-server.js"]
