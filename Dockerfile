FROM node:20-slim

LABEL maintainer="you@example.com"
LABEL description="Custom MCP PlantUML Server with HTTP support"

# Create app directory
WORKDIR /app

# Copy all project files (including src, package.json, tsconfig.json)
COPY . .

# Install dependencies (including express)
RUN npm install --omit=dev && npm install express

# Build the TypeScript project
RUN npm run build

# Environment defaults
ENV NODE_ENV=production
ENV PORT=8765
ENV TRANSPORT=http
ENV PLANTUML_SERVER_URL=https://www.plantuml.com/plantuml

# Expose MCP port
EXPOSE 8765

# Start the HTTP server by default
CMD ["node", "dist/plantuml-mcp-server.js"]
