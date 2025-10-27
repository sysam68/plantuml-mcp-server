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
 * - Incoming MCP requests over HTTP (/mcp) respond normally.
 * - MCP requests over SSE (/sse) are handled and results are sent as SSE events.
 * - When a client disconnects, the session is cleaned up.
 *
 * This design ensures compatibility with Flowise and other MCP clients expecting JSON-RPC over HTTP or SSE.
 */

import express from "express";
import plantumlEncoder from "plantuml-encoder";
import { v4 as uuidv4 } from "uuid";

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
  const { plantuml_code, format = "svg" } = args;
  if (!plantuml_code) throw new Error("Missing 'plantuml_code' parameter.");

  const encoded = encodePlantUML(plantuml_code);
  const diagramUrl = `${PLANTUML_SERVER_URL}/${format}/${encoded}`;

  return {
    content: [
      {
        type: "text",
        text: `✅ **Generated PlantUML diagram**\n\n**URL:** ${diagramUrl}\n\n**Markdown:**\n\`\`\`markdown\n![PlantUML Diagram](${diagramUrl})\n\`\`\``,
      },
    ],
  };
}

function encodeTool(args: any) {
  const encoded = encodePlantUML(args.plantuml_code);
  return {
    content: [
      {
        type: "text",
        text: `**Encoded string:** \`${encoded}\`\n\n**URL:** ${PLANTUML_SERVER_URL}/svg/${encoded}`,
      },
    ],
  };
}

function decodeTool(args: any) {
  const decoded = decodePlantUML(args.encoded_string);
  return {
    content: [
      {
        type: "text",
        text: `**Decoded PlantUML:**\n\`\`\`plantuml\n${decoded}\n\`\`\``,
      },
    ],
  };
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

  switch (method) {
    // --- Standard MCP handshake ---
    case "initialize":
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
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const { name, arguments: args } = params || {};
      if (!name) throw new Error("Missing 'name' in tools/call parameters.");

      switch (name) {
        case "generate_plantuml_diagram":
          return { jsonrpc: "2.0", id, result: await generatePlantUMLDiagram(args) };
        case "encode_plantuml":
          return { jsonrpc: "2.0", id, result: encodeTool(args) };
        case "decode_plantuml":
          return { jsonrpc: "2.0", id, result: decodeTool(args) };
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    }

    // --- Prompts management ---
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };

    case "prompts/get":
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
      throw new Error(`Unknown prompt: ${params?.name}`);

    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

// --- Server setup ---
const app = express();
app.use(express.json());

// Optional API key middleware for HTTP endpoints
app.use((req, res, next) => {
  // Skip authentication for /.well-known/mcp/server-metadata
  if (req.path === "/.well-known/mcp/server-metadata") return next();

  const expectedKey = process.env.MCP_API_KEY;
  if (!expectedKey) return next();
  const authHeader = req.headers['authorization'];
  const valid = authHeader === `Bearer ${expectedKey}`;
  if (!valid) {
    const id = req.body?.id || "1";
    res.status(401).json({
      jsonrpc: "2.0",
      id,
      error: { message: "Unauthorized: invalid or missing API key" }
    });
    return;
  }
  next();
});

// Discovery endpoint with full MCP SSE metadata
app.get("/.well-known/mcp/server-metadata", (req, res) => {
  res.json({
    name: "plantuml-server",
    version: "0.2.0",
    description: "MCP SSE & HTTP server for PlantUML diagrams",
    transport: "sse",
    protocolVersion: "2025-06-18",
    authentication: "bearer",
    capabilities: {
      tools: true,
      prompts: true,
    },
  });
});

// Unified MCP endpoint (strict JSON-RPC) - HTTP classic
app.post("/mcp", async (req, res) => {
  try {
    // Compatibility safeguard: ensure id is present and default to 1 if missing
    if (typeof req.body?.id === "undefined" || req.body?.id === null) {
      req.body.id = 1;
    }
    const response = await handleMCPRequest(req.body);

    // --- Always wrap tools/list and prompts/list in JSON-RPC envelope as Flowise expects ---
    if (req.body.method === "tools/list") {
      const tools = (response as any)?.result?.tools || (response as any)?.tools;
      return res.json({
        jsonrpc: "2.0",
        id: String(req.body.id || "1"),
        result: { tools: tools || [] },
      });
    }
    if (req.body.method === "prompts/list") {
      const prompts = (response as any)?.result?.prompts || (response as any)?.prompts;
      return res.json({
        jsonrpc: "2.0",
        id: String(req.body.id || "1"),
        result: { prompts: prompts || [] },
      });
    }

    // --- Normal MCP response ---
    res.json(response);
  } catch (err: any) {
    console.error("❌ MCP error:", err.message);
    // Always return JSON-RPC error envelope, with id defaulted to 1 if missing, and as string
    const id = String(req.body?.id || "1");
    res.status(500).json({
      jsonrpc: "2.0",
      id,
      error: { message: err.message },
    });
  }
});

// MCP SSE endpoint
app.get("/sse", (req, res) => {
  const expectedKey = process.env.MCP_API_KEY;
  if (!expectedKey) {
    res.status(500).send("Server misconfiguration: MCP_API_KEY not set");
    return;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${expectedKey}`) {
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

  // Send initial comment to keep connection alive in some proxies
  res.write(`: connected\n\n`);

  // Store session
  sessions.set(sessionId, { res });

  // Heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 30000);

  // Handle client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    sessions.delete(sessionId);
  });
});

// Function to send JSON-RPC response via SSE to all active sessions
function sendSSEMessage(message: any) {
  const data = JSON.stringify(message);
  for (const [, { res }] of sessions) {
    res.write(`data: ${data}\n\n`);
  }
}

// Wrap handleMCPRequest to optionally send via SSE if session active
async function handleMCPRequestWithSSE(request: any) {
  const response = await handleMCPRequest(request);
  // If the request contains a sessionId param and that session exists, send via SSE
  if (request.params?.sessionId && sessions.has(request.params.sessionId)) {
    sendSSEMessage(response);
    return null; // Indicate response sent via SSE
  }
  return response;
}

// Overwrite /mcp POST handler to support optional sessionId param for SSE
app.post("/mcp", async (req, res) => {
  try {
    if (typeof req.body?.id === "undefined" || req.body?.id === null) {
      req.body.id = 1;
    }
    const response = await handleMCPRequestWithSSE(req.body);

    if (response === null) {
      // Response was sent via SSE, so just end HTTP response with 204 No Content
      res.status(204).end();
      return;
    }

    // --- Always wrap tools/list and prompts/list in JSON-RPC envelope as Flowise expects ---
    if (req.body.method === "tools/list") {
      const tools = (response as any)?.result?.tools || (response as any)?.tools;
      return res.json({
        jsonrpc: "2.0",
        id: String(req.body.id || "1"),
        result: { tools: tools || [] },
      });
    }
    if (req.body.method === "prompts/list") {
      const prompts = (response as any)?.result?.prompts || (response as any)?.prompts;
      return res.json({
        jsonrpc: "2.0",
        id: String(req.body.id || "1"),
        result: { prompts: prompts || [] },
      });
    }

    // --- Normal MCP response ---
    res.json(response);
  } catch (err: any) {
    console.error("❌ MCP error:", err.message);
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
  console.log(`✅ MCP PlantUML server running on http://localhost:${SERVER_PORT}`);
  console.log(`✅ MCP SSE endpoint available at http://localhost:${SERVER_PORT}/sse`);
});