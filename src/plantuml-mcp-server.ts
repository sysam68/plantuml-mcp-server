#!/usr/bin/env node
/**
 * 🌿 PlantUML MCP Server — MCP SSE & HTTP compliant with Model Context Protocol 2025-06-18
 * Author: Sylvain + GPT-5
 * Version: 0.2.0
 *
 * This server supports both classic HTTP JSON-RPC requests on /mcp and stateful MCP SSE connections on /sse.
 *
 * MCP SSE protocol is stateful per connection, maintaining an open Server-Sent Events (SSE) stream.
 * Clients authenticate using a Bearer token (MCP_API_KEY) and receive JSON-RPC responses pushed asynchronously.
 *
 * SSE stream management:
 * - Each client connection is stored in a sessions map keyed by a unique session ID.
 * - Incoming MCP requests over HTTP (/mcp) respond normally or send results via SSE if requested.
 * - When a client disconnects, the session is cleaned up.
 *
 * This design ensures compatibility with Flowise and other MCP clients expecting JSON-RPC over HTTP or SSE.
 */

import express from "express";
import plantumlEncoder from "plantuml-encoder";
import { v4 as uuidv4 } from "uuid";

const LEVELS: Record<"error" | "warn" | "info" | "debug", number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const LOG_LEVEL = (process.env.LOG_LEVEL || "info") as keyof typeof LEVELS;

function log(level: keyof typeof LEVELS, message: string, ...args: any[]) {
  const currentLevel = LEVELS[LOG_LEVEL];
  const msgLevel = LEVELS[level];
  if (msgLevel <= currentLevel) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${message}`, ...args);
  }
}

// Configuration (local or remote PlantUML server)
const PLANTUML_SERVER_URL = process.env.PLANTUML_SERVER_URL || "http://plantuml:8080/plantuml";
const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT) : 8765;

// --- Helper functions ---
function encodePlantUML(code: string) {
  return plantumlEncoder.encode(code);
}
function decodePlantUML(encoded: string) {
  return plantumlEncoder.decode(encoded);
}

// --- Tool definitions (MCP-compliant) ---
const TOOLS = [
  {
    name: "generate_plantuml_diagram",
    description:
      "Generate a PlantUML diagram (SVG or PNG) with optional syntax validation. Returns embeddable URLs.",
    inputSchema: {
      type: "object",
      properties: {
        plantuml_code: {
          type: "string",
          description: "PlantUML diagram code to generate an image from.",
        },
        format: {
          type: "string",
          enum: ["svg", "png"],
          default: "svg",
          description: "Output image format (SVG or PNG).",
        },
      },
      required: ["plantuml_code"],
    },
  },
  {
    name: "encode_plantuml",
    description: "Encode PlantUML source code for use in URLs.",
    inputSchema: {
      type: "object",
      properties: {
        plantuml_code: {
          type: "string",
          description: "PlantUML diagram code to encode.",
        },
      },
      required: ["plantuml_code"],
    },
  },
  {
    name: "decode_plantuml",
    description: "Decode a PlantUML URL-safe string back to source code.",
    inputSchema: {
      type: "object",
      properties: {
        encoded_string: {
          type: "string",
          description: "Encoded PlantUML string to decode.",
        },
      },
      required: ["encoded_string"],
    },
  },
];

// --- Tool logic ---
async function generatePlantUMLDiagram(args: any) {
  log("debug", `Executing tool generate_plantuml_diagram with args`, args);
  const { plantuml_code, format = "svg" } = args;
  if (!plantuml_code) {
    log("error", `generate_plantuml_diagram missing 'plantuml_code' parameter`);
    throw new Error("Missing 'plantuml_code' parameter.");
  }

  const encoded = encodePlantUML(plantuml_code);
  const diagramUrl = `${PLANTUML_SERVER_URL}/${format}/${encoded}`;

  const result = {
    content: [
      {
        type: "text",
        text: `✅ **Generated PlantUML diagram**\n\n**URL:** ${diagramUrl}\n\n**Markdown:**\n\`\`\`markdown\n![PlantUML Diagram](${diagramUrl})\n\`\`\``,
      },
    ],
  };
  log("debug", `Tool generate_plantuml_diagram result prepared`);
  return result;
}

function encodeTool(args: any) {
  log("debug", `Executing tool encode_plantuml with args`, args);
  const encoded = encodePlantUML(args.plantuml_code);
  const result = {
    content: [
      {
        type: "text",
        text: `**Encoded string:** \`${encoded}\`\n\n**URL:** ${PLANTUML_SERVER_URL}/svg/${encoded}`,
      },
    ],
  };
  log("debug", `Tool encode_plantuml result prepared`);
  return result;
}

function decodeTool(args: any) {
  log("debug", `Executing tool decode_plantuml with args`, args);
  const decoded = decodePlantUML(args.encoded_string);
  const result = {
    content: [
      {
        type: "text",
        text: `**Decoded PlantUML:**\n\`\`\`plantuml\n${decoded}\n\`\`\``,
      },
    ],
  };
  log("debug", `Tool decode_plantuml result prepared`);
  return result;
}

// --- Prompt definitions ---
const PROMPTS = [
  {
    name: "plantuml_error_handling",
    description: "Guidelines for handling PlantUML syntax errors and fixes.",
  },
];

// --- Sessions map for SSE connections ---
const sessions = new Map<string, { res: express.Response }>();

// --- Core MCP Handler ---
async function handleMCPRequest(request: any) {
  const { method, id, params } = request;
  log("info", `📥 Handling MCP request: method=${method}, id=${id}`);

  switch (method) {
    // --- Standard MCP handshake ---
    case "initialize":
      log("debug", `Processing 'initialize' request with id: ${id}`);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: {
            name: "plantuml-server",
            version: "0.2.0",
            description: "MCP SSE & HTTP server for PlantUML diagrams",
          },
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
          },
        },
      };

    // --- Tools management ---
    case "tools/list":
      log("debug", `Processing 'tools/list' request with id: ${id}`);
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const { name, arguments: args } = params || {};
      log("debug", `Processing 'tools/call' request with id: ${id}, tool: ${name}`, { args });
      if (!name) {
        log("error", `tools/call missing 'name' parameter`);
        throw new Error("Missing 'name' in tools/call parameters.");
      }

      switch (name) {
        case "generate_plantuml_diagram":
          const genResult = await generatePlantUMLDiagram(args);
          log("debug", `Tool 'generate_plantuml_diagram' executed successfully for id: ${id}`);
          return { jsonrpc: "2.0", id, result: genResult };
        case "encode_plantuml":
          const encResult = encodeTool(args);
          log("debug", `Tool 'encode_plantuml' executed successfully for id: ${id}`);
          return { jsonrpc: "2.0", id, result: encResult };
        case "decode_plantuml":
          const decResult = decodeTool(args);
          log("debug", `Tool 'decode_plantuml' executed successfully for id: ${id}`);
          return { jsonrpc: "2.0", id, result: decResult };
        default:
          log("error", `Unknown tool '${name}' requested in tools/call`);
          throw new Error(`Unknown tool: ${name}`);
      }
    }

    // --- Prompts management ---
    case "prompts/list":
      log("debug", `Processing 'prompts/list' request with id: ${id}`);
      return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };

    case "prompts/get":
      log("debug", `Processing 'prompts/get' request with id: ${id}, prompt name: ${params?.name}`);
      if (params?.name === "plantuml_error_handling") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: "Error handling guide",
            messages: [
              {
                role: "assistant",
                content: {
                  type: "text",
                  text: "Use @startuml and @enduml, check syntax and retry.",
                },
              },
            ],
          },
        };
      }
      log("error", `Unknown prompt requested: ${params?.name}`);
      throw new Error(`Unknown prompt: ${params?.name}`);

    default:
      log("error", `Unsupported MCP method requested: ${method}`);
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

// --- Server setup ---
const app = express();
app.use(express.json());

// Authentication middleware for /mcp and /sse endpoints
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Skip authentication for /.well-known/mcp/server-metadata and /health
  if (req.path === "/.well-known/mcp/server-metadata" || req.path === "/health") {
    log("debug", `Skipping authentication for path: ${req.path}`);
    return next();
  }

  const expectedKey = process.env.MCP_API_KEY;
  if (!expectedKey) {
    log("error", `Authentication failed: MCP_API_KEY not set`);
    // If no API key set, reject requests requiring auth
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body?.id || "1",
      error: { message: "Server misconfiguration: MCP_API_KEY not set" },
    });
    return;
  }
  const authHeader = req.headers['authorization'];
  const valid = authHeader === `Bearer ${expectedKey}`;
  if (!valid) {
    const id = req.body?.id || "1";
    log("warn", `Unauthorized access attempt with id: ${id}, path: ${req.path}`);
    res.status(401).json({
      jsonrpc: "2.0",
      id,
      error: { message: "Unauthorized: invalid or missing API key" }
    });
    return;
  }
  log("debug", `Authentication successful for path: ${req.path}`);
  next();
}

app.use(authMiddleware);

// Discovery endpoint with full MCP SSE metadata
app.get("/.well-known/mcp/server-metadata", (req, res) => {
  log("info", `Serving server metadata to ${req.ip}`);
  res.json({
    name: "plantuml-server",
    version: "0.2.0",
    description: "MCP SSE & HTTP server for PlantUML diagrams",
    transport: "sse",
    protocolVersion: "2025-06-18",
    authentication: "bearer",
    capabilities: {
      tools: TOOLS.map(t => t.name),
      prompts: PROMPTS.map(p => p.name),
    },
  });
});

// Healthcheck endpoint for Docker
app.get("/health", (req, res) => {
  log("info", `Health check requested from ${req.ip}`);
  res.status(200).send("OK");
});

// MCP SSE endpoint (Brave Search style)
app.get("/sse", (req, res) => {
  const expectedKey = process.env.MCP_API_KEY;
  if (!expectedKey) {
    log("error", `SSE connection attempt failed: MCP_API_KEY not set`);
    res.status(500).send("Server misconfiguration: MCP_API_KEY not set");
    return;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${expectedKey}`) {
    log("warn", `Unauthorized SSE connection attempt from ${req.ip}`);
    res.status(401).json({
      jsonrpc: "2.0",
      id: "1",
      error: { message: "Unauthorized: invalid or missing API key" }
    });
    return;
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Generate unique session ID
  const sessionId = uuidv4();
  sessions.set(sessionId, { res });
  log("info", `🔗 SSE client connected: sessionId=${sessionId} ip=${req.ip}`);

  // Send initial comment
  res.write(`: connected\n\n`);

  // Send notifications/initialized event
  res.write(`event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {
      capabilities: {
        tools: TOOLS.map(t => t.name),
        prompts: PROMPTS.map(p => p.name),
      }
    }
  })}\n\n`);
  log("info", `Sent notifications/initialized to sessionId=${sessionId}`);

  // Send tools/list event (so client can populate tools)
  res.write(`event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/list",
    params: { tools: TOOLS }
  })}\n\n`);
  log("info", `Sent tools/list to sessionId=${sessionId}`);

  // Send notifications/ready event
  res.write(`event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/ready",
    params: {}
  })}\n\n`);
  log("info", `Sent notifications/ready to sessionId=${sessionId}`);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(`event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/keepalive",
      params: {}
    })}\n\n`);
    log("info", `💓 Sent keepalive to sessionId=${sessionId}`);
  }, 30000);

  // Handle client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    sessions.delete(sessionId);
    log("info", `❌ SSE client disconnected: sessionId=${sessionId} ip=${req.ip}`);
  });
});

// Function to send JSON-RPC response via SSE to all active sessions
function sendSSEMessage(message: any) {
  log("debug", `Sending SSE message to ${sessions.size} sessions`, message);
  const data = JSON.stringify(message);
  for (const [sessionId, { res }] of sessions) {
    try {
      res.write(`event: message\ndata: ${data}\n\n`);
      log("debug", `SSE message sent to sessionId: ${sessionId}`);
    } catch (err) {
      log("warn", `Failed to send SSE message to sessionId: ${sessionId}`, err);
    }
  }
}

// Function to send MCP result via SSE with log
function sendMCPResult(id: string, result: any) {
  const message = {
    jsonrpc: "2.0",
    id,
    result,
  };
  sendSSEMessage(message);
  log("info", `✅ Sent MCP result via SSE for id: ${id}`);
}

// Unified MCP endpoint (strict JSON-RPC) - HTTP classic or SSE if sessionId provided
app.post("/mcp", async (req, res) => {
  try {
    // Compatibility safeguard: ensure id is present and default to 1 if missing
    if (typeof req.body?.id === "undefined" || req.body?.id === null) {
      req.body.id = 1;
    }

    const request = req.body;
    log("info", `Received MCP request with method: ${request.method}, id: ${request.id}`);

    const response = await handleMCPRequest(request);
    log("info", `📤 MCP response prepared for method=${request.method}, id=${request.id}`);

    // If there is at least one SSE session, send result via SSE and return 204
    if (sessions.size > 0) {
      sendMCPResult(String(request.id), (response as any).result);
      return res.status(204).end();
    }
    res.json(response);
  } catch (err: any) {
    log("error", `❌ MCP error for id: ${req.body?.id || "unknown"}:`, err.message);
    // Always return JSON-RPC error envelope, with id defaulted to 1 if missing, and as string
    const id = String(req.body?.id || "1");
    res.status(500).json({
      jsonrpc: "2.0",
      id,
      error: { message: err.message },
    });
  }
});

// Start server
app.listen(SERVER_PORT, () => {
  log("info", `✅ MCP PlantUML server running on http://localhost:${SERVER_PORT}`);
  log("info", `✅ MCP SSE endpoint available at http://localhost:${SERVER_PORT}/sse`);
});