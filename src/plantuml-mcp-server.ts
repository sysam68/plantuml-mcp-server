#!/usr/bin/env node
/**
 * PlantUML MCP Server — HTTP version (fully compliant with Model Context Protocol)
 * Version: 0.1.11
 */

import express from "express";
import bodyParser from "body-parser";
//import fetch from "node-fetch";
import plantumlEncoder from "plantuml-encoder";

const PLANTUML_SERVER_URL =
  process.env.PLANTUML_SERVER_URL || "https://www.plantuml.com/plantuml";
const PORT = process.env.PORT || 8765;

// --- Utility Functions ------------------------------------------------------

function encodePlantUML(plantuml: string): string {
  return plantumlEncoder.encode(plantuml);
}

function decodePlantUML(encoded: string): string {
  return plantumlEncoder.decode(encoded);
}

// --- MCP Tool Handlers ------------------------------------------------------

async function generatePlantUMLDiagram(args: any) {
  const { plantuml_code, format = "svg" } = args || {};

  if (!plantuml_code) {
    throw new Error("Missing required argument: plantuml_code");
  }

  const encoded = encodePlantUML(plantuml_code);
  const url = `${PLANTUML_SERVER_URL}/${format}/${encoded}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`PlantUML server error: ${response.statusText}`);
  }

  return {
    image_url: url,
    markdown: `![PlantUML Diagram](${url})`,
  };
}

async function encodePlantUMLTool(args: any) {
  const { plantuml_code } = args || {};
  if (!plantuml_code) {
    throw new Error("Missing required argument: plantuml_code");
  }
  const encoded = encodePlantUML(plantuml_code);
  return {
    encoded,
    svg_url: `${PLANTUML_SERVER_URL}/svg/${encoded}`,
    png_url: `${PLANTUML_SERVER_URL}/png/${encoded}`,
  };
}

async function decodePlantUMLTool(args: any) {
  const { encoded_string } = args || {};
  if (!encoded_string) {
    throw new Error("Missing required argument: encoded_string");
  }
  const decoded = decodePlantUML(encoded_string);
  return { decoded };
}

// --- MCP Tools Catalog ------------------------------------------------------

const TOOLS = [
  {
    name: "generate_plantuml_diagram",
    description: "Generate a PlantUML diagram (SVG or PNG) from UML code.",
    inputSchema: {
      type: "object",
      properties: {
        plantuml_code: { type: "string", description: "PlantUML source code" },
        format: {
          type: "string",
          enum: ["svg", "png"],
          default: "svg",
          description: "Output image format",
        },
      },
      required: ["plantuml_code"],
    },
  },
  {
    name: "encode_plantuml",
    description: "Encode PlantUML code into a URL-safe format.",
    inputSchema: {
      type: "object",
      properties: {
        plantuml_code: {
          type: "string",
          description: "PlantUML source to encode",
        },
      },
      required: ["plantuml_code"],
    },
  },
  {
    name: "decode_plantuml",
    description: "Decode a URL-safe PlantUML string.",
    inputSchema: {
      type: "object",
      properties: {
        encoded_string: {
          type: "string",
          description: "Encoded PlantUML string",
        },
      },
      required: ["encoded_string"],
    },
  },
];

// --- MCP Core Logic ---------------------------------------------------------

async function handleMCPRequest(request: any) {
  const { method, params, id } = request;

  switch (method) {
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const { name, arguments: args } = params || {};
      if (!name) {
        throw new Error("Missing tool name in parameters");
      }

      switch (name) {
        case "generate_plantuml_diagram":
          return { jsonrpc: "2.0", id, result: await generatePlantUMLDiagram(args) };
        case "encode_plantuml":
          return { jsonrpc: "2.0", id, result: await encodePlantUMLTool(args) };
        case "decode_plantuml":
          return { jsonrpc: "2.0", id, result: await decodePlantUMLTool(args) };
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    }

    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

// --- Express Server ---------------------------------------------------------

const app = express();
app.use(bodyParser.json());
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

// MCP metadata (discovery)
app.get("/.well-known/mcp/server-metadata", (req, res) => {
  res.json({
    mcpVersion: "2024-10-01",
    name: "plantuml-server",
    version: "0.1.11",
    description: "HTTP MCP server for PlantUML diagram generation",
    transport: "http",
    capabilities: { tools: true, prompts: false },
    tools: TOOLS,
  });
});

// Unified MCP endpoint
app.all("/mcp", async (req, res) => {
  try {
    const request =
      req.method === "GET"
        ? { jsonrpc: "2.0", id: Date.now().toString(), method: "tools/list", params: {} }
        : req.body;

    console.log(`📩 MCP Request: ${JSON.stringify(request)}`);

    const response = await handleMCPRequest(request);
    res.json(response);
  } catch (err: any) {
    console.error("❌ MCP Error:", err.message);
    res.status(500).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: err.message },
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ MCP PlantUML server running on http://localhost:${PORT}`);
});