#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import plantumlEncoder from "plantuml-encoder";

// --- Logger setup ---
const LOG_LEVELS = ["error", "warn", "info", "debug"];
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const currentLogLevelIndex = LOG_LEVELS.indexOf(LOG_LEVEL);

function log(level, message) {
  if (LOG_LEVELS.indexOf(level) <= currentLogLevelIndex) {
    console.error(`[${level.toUpperCase()}] ${message}`);
  }
}

// --- Environment variables ---
const MCP_API_KEY = process.env.MCP_API_KEY;
const MCP_PORT = process.env.MCP_PORT || "3000";
const NODE_ENV = process.env.NODE_ENV || "development";

if (!MCP_API_KEY) {
  log("warn", "MCP_API_KEY is not defined. Authentication will be disabled.");
} else {
  log("info", "MCP_API_KEY is set.");
}
log("info", `Server will run on port: ${MCP_PORT}`);
log("info", `Environment mode: ${NODE_ENV}`);

// --- Tools definitions (PlantUML specific) ---
const TOOLS = [
  {
    name: "generate_plantuml_diagram",
    description: "Generate a PlantUML diagram (SVG or PNG) from UML source code.",
    inputSchema: {
      type: "object",
      properties: {
        plantuml_code: {
          type: "string",
          description: "PlantUML code to convert.",
        },
        format: {
          type: "string",
          enum: ["svg", "png"],
          default: "svg",
          description: "Output format.",
        },
      },
      required: ["plantuml_code"],
    },
  },
  {
    name: "encode_plantuml",
    description: "Encode PlantUML text for use in a PlantUML server URL.",
    inputSchema: {
      type: "object",
      properties: {
        plantuml_code: { type: "string", description: "PlantUML code to encode." },
      },
      required: ["plantuml_code"],
    },
  },
  {
    name: "decode_plantuml",
    description: "Decode a PlantUML-encoded string back to source text.",
    inputSchema: {
      type: "object",
      properties: {
        encoded_string: { type: "string", description: "Encoded PlantUML string." },
      },
      required: ["encoded_string"],
    },
  },
];

// --- Prompts definitions ---
const PROMPTS = [
  {
    name: "plantuml_error_handling",
    description: "Tips for fixing PlantUML syntax errors.",
  },
];

// --- Tool Logic ---
const PLANTUML_SERVER_URL = process.env.PLANTUML_SERVER_URL || "http://plantuml:8080/plantuml";

async function generatePlantUMLDiagram(args: any) {
  const { plantuml_code, format = "svg" } = args;
  log("debug", "Encoding PlantUML code for diagram generation");
  const encoded = plantumlEncoder.encode(plantuml_code);
  const diagramUrl = `${PLANTUML_SERVER_URL}/${format}/${encoded}`;
  return `✅ Generated PlantUML diagram:\n${diagramUrl}\n\nMarkdown:\n\`\`\`markdown\n![Diagram](${diagramUrl})\n\`\`\``;
}

function encodePlantUML(args: any) {
  log("debug", "Encoding PlantUML code");
  const encoded = plantumlEncoder.encode(args.plantuml_code);
  return `Encoded string:\n\`${encoded}\`\nURL: ${PLANTUML_SERVER_URL}/svg/${encoded}`;
}

function decodePlantUML(args: any) {
  log("debug", "Decoding PlantUML encoded string");
  const decoded = plantumlEncoder.decode(args.encoded_string);
  return `Decoded PlantUML:\n\`\`\`plantuml\n${decoded}\n\`\`\``;
}

// --- Server setup (Brave Search style) ---
const server = new Server(
  {
    name: "plantuml-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// --- Handle requests ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("debug", "Received ListTools request");
  return {
    tools: TOOLS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  log("debug", `Received CallTool request for tool: ${request.params.name}`);
  log("debug", `Request arguments: ${JSON.stringify(request.params.arguments)}`);

  // Authentication check
  if (MCP_API_KEY) {
    const authHeader = request.headers?.authorization;
    if (!authHeader || authHeader !== `Bearer ${MCP_API_KEY}`) {
      log("warn", "Unauthorized CallTool request blocked due to missing or invalid authorization header.");
      return {
        content: [{ type: "text", text: "Unauthorized: Invalid or missing authorization header." }],
        isError: true,
      };
    }
  }

  try {
    const { name, arguments: args } = request.params;

    let result;
    switch (name) {
      case "generate_plantuml_diagram":
        log("debug", "Calling generate_plantuml_diagram tool");
        result = await generatePlantUMLDiagram(args);
        break;

      case "encode_plantuml":
        log("debug", "Calling encode_plantuml tool");
        result = encodePlantUML(args);
        break;

      case "decode_plantuml":
        log("debug", "Calling decode_plantuml tool");
        result = decodePlantUML(args);
        break;

      default:
        log("warn", `Unknown tool requested: ${name}`);
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    log("debug", `Tool result: ${result}`);
    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    log("error", `Error handling CallTool request: ${error.stack || error.message || error}`);
    return {
      content: [
        {
          type: "text",
          text: `Error processing request: ${error.message || error}`,
        },
      ],
      isError: true,
    };
  }
});

// --- Start server (STDIO transport) ---
const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "🌿 PlantUML MCP Server running via stdio");