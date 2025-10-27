#!/usr/bin/env node
/**
 * 🌿 PlantUML MCP Server — HTTP compliant with Model Context Protocol 2025-06-18
 * Author: Sylvain + GPT-5
 * Version: 0.2.0
 */

import express from "express";
import plantumlEncoder from "plantuml-encoder";

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
            description: "MCP HTTP server for PlantUML diagrams",
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

// Discovery endpoint
app.get("/.well-known/mcp/server-metadata", (req, res) => {
  res.json({
    name: "plantuml-server",
    version: "0.2.0",
    description: "MCP HTTP server for PlantUML diagrams",
    transport: "http",
  });
});

// Unified MCP endpoint (strict JSON-RPC)
app.post("/mcp", async (req, res) => {
  try {
    const response = await handleMCPRequest(req.body);

    // Flowise expects top-level "tools" field, not wrapped in JSON-RPC "result"
    if (req.body.method === "tools/list" && response?.result?.tools) {
      res.json({ tools: response.result.tools });
    } else {
      res.json(response);
    }
  } catch (err: any) {
    console.error("❌ MCP error:", err.message);
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body?.id || null,
      error: { message: err.message },
    });
  }
});

// Start server
app.listen(SERVER_PORT, () => {
  console.log(`✅ MCP PlantUML server running on http://localhost:${SERVER_PORT}`);
});