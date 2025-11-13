#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import * as contentType from 'content-type';
import plantumlEncoder from 'plantuml-encoder';
import getRawBody from 'raw-body';

const LOG_LEVELS = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_ALIASES: Record<string, LogLevel> = {
  warn: 'warning',
  warning: 'warning',
  err: 'error',
  fatal: 'critical',
};

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (LOG_LEVELS.includes(normalized as LogLevel)) {
    return normalized as LogLevel;
  }

  if (LOG_LEVEL_ALIASES[normalized]) {
    return LOG_LEVEL_ALIASES[normalized];
  }

  return fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/\/+$/, '');
}

const requestedLogLevel = parseLogLevel(process.env.LOG_LEVEL, 'info');
const logLevelIndex =
  LOG_LEVELS.indexOf(requestedLogLevel) !== -1 ? LOG_LEVELS.indexOf(requestedLogLevel) : LOG_LEVELS.indexOf('info');

function logToConsole(level: LogLevel, message: string, error?: unknown) {
  if (LOG_LEVELS.indexOf(level) > logLevelIndex) {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const text = `${prefix} ${message}`;

  if (level === 'error' || level === 'critical' || level === 'alert' || level === 'emergency') {
    if (error instanceof Error && error.stack) {
      console.error(`${text}\n${error.stack}`);
    } else if (error) {
      console.error(`${text} ${String(error)}`);
    } else {
      console.error(text);
    }
    return;
  }

  if (level === 'warning') {
    console.warn(text);
  } else if (level === 'debug') {
    console.debug(text);
  } else {
    console.info(text);
  }
}

const SERVER_VERSION = process.env.npm_package_version || '0.1.3';
const PLANTUML_SERVER_URL = process.env.PLANTUML_SERVER_URL || 'https://www.plantuml.com/plantuml';
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || 'http').toLowerCase();
const MCP_HOST = process.env.MCP_HOST || '0.0.0.0';
const MCP_PORT = Number.parseInt(process.env.MCP_PORT || '3000', 10);
const MCP_HTTP_PATH = normalizePath(process.env.MCP_HTTP_PATH || '/mcp');
const MCP_HTTP_ENABLE_JSON_RESPONSES = parseBoolean(process.env.MCP_HTTP_ENABLE_JSON_RESPONSES, false);
const MCP_SSE_PATH = normalizePath(process.env.MCP_SSE_PATH || '/sse');
const MCP_SSE_MESSAGES_PATH = normalizePath(process.env.MCP_SSE_MESSAGES_PATH || '/messages');
const MCP_API_KEY = process.env.MCP_API_KEY;
const GENERATED_FILES_DIR = path.resolve(process.env.GENERATED_FILES_DIR || '/generated-files');
const PUBLIC_FILE_BASE_URL = normalizeBaseUrl(process.env.PUBLIC_FILE_BASE_URL || 'https://ob-file.fmpn.fr/files');
const MAXIMUM_MESSAGE_SIZE = '4mb';
const COMPLETION_MAX_RESULTS = 100;

logToConsole('info', `Log level set to ${requestedLogLevel}`);
if (MCP_API_KEY) {
  logToConsole('info', 'MCP API key authentication enabled.');
} else {
  logToConsole('warning', 'MCP_API_KEY not set. Server will accept unauthenticated requests.');
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARCHIMATE_SAMPLE_CANDIDATES = [
  path.resolve(MODULE_DIR, '../../../plugins/samples/Archimate-Elements.wsd'),
  path.resolve(MODULE_DIR, '../../../plugins/dist/plantuml-stdlib/stdlib/archimate/_examples_/Archimate-Elements.wsd'),
  path.resolve(process.cwd(), 'plantUML/plugins/samples/Archimate-Elements.wsd'),
];
const ARCHIMATE_SAMPLE_FALLBACK = `@startuml
!include <archimate/Archimate>
Business_Actor(FallbackActor, \"Business Actor\")
@enduml`;

const ARCHIMATE_ELEMENTS_REFERENCE_SOURCE = await (async () => {
  for (const candidate of ARCHIMATE_SAMPLE_CANDIDATES) {
    try {
      const data = await fs.readFile(candidate, 'utf8');
      logToConsole('debug', `Loaded ArchiMate sample from ${candidate}`);
      return data.trim();
    } catch {
      // Continue to next candidate
    }
  }
  logToConsole('warning', 'Unable to load ArchiMate sample locally. Falling back to minimal embedded reference.');
  return ARCHIMATE_SAMPLE_FALLBACK;
})();

type PromptArgument = {
  name: string;
  description?: string;
  required?: boolean;
};

type PromptTemplateArgs = Record<string, string | undefined>;

type PromptDefinition = {
  name: string;
  title?: string;
  description: string;
  arguments?: PromptArgument[];
  template: (args?: PromptTemplateArgs) => string;
};

const PLANTUML_ERROR_PROMPT_BODY = `## PlantUML MCP Server - Error Handling & Auto-Fix Guide

### Error Detection Workflow
1. Always attempt diagram generation first with \`generate_plantuml_diagram\`
2. Inspect the response for \`validation_failed: true\`
3. Extract detailed error context from \`error_details\`
4. Apply auto-fixes when safe and retry up to two times
5. Surface the error to the user with guidance if all retries fail

### Response Format Recognition

**Success Response**
- Returns embeddable URLs and markdown
- Includes the text \`Successfully generated PlantUML diagram!\`

**Validation Error Response**
\`\`\`json
{
  "validation_failed": true,
  "error_details": {
    "error_message": "Syntax Error description",
    "error_line": 3,
    "problematic_code": "invalid syntax line",
    "full_plantuml": "complete original code",
    "full_context": "detailed error context"
  },
  "retry_instructions": "Fix errors and retry"
}
\`\`\`

**Server Error Response**
- Indicates connectivity issues or PlantUML server downtime

### Common PlantUML Syntax Fixes
- Missing \`@startuml\` or \`@enduml\`
- Invalid arrow syntax (use \`->\`, \`-->\`, \`<-\`, etc.)
- Keywords with typos (participant, class, note, etc.)
- Missing quotes around strings that contain spaces
- Using diagram elements that do not match the diagram type

### Auto-Fix Strategy
1. Read \`error_message\`, \`error_line\`, and \`problematic_code\`
2. Apply targeted corrections (add tags, fix arrows, add quotes, fix typos)
3. Preserve the user's original intent wherever possible
4. Retry generation once corrections are applied
5. Explain any fixes made when presenting the final result

### Error Handling Helper (pseudocode)
\`\`\`typescript
const result = await generatePlantUMLDiagram(code);
if (isValidationError(result)) {
  const fixed = autoFixSyntax(result.error_details);
  if (fixed) {
    return await generatePlantUMLDiagram(fixed);
  }
  return showErrorToUser(result.error_details);
}
return result; // Success path
\`\`\`

### Best Practices
- Do not share invalid diagram URLs with users
- Store the original code before attempting fixes
- Provide clear feedback on what was corrected
- Offer manual follow-up steps if automatic fixes fail
`;

const DEFAULT_CAPABILITY_LANDSCAPE_SNIPPET = `@startuml
!theme archimate-standard from <archimate/themes>

!include <archimate/Archimate>

Group(GroupingAreaAUniqueCode, "Grouping Area A"){
    Strategy_Capability(CapabilityDomain01UniqueCode, "A Capability Domain belonging the Grouping Area A") {
      Strategy_Capability(OperationalCapability01UniqueCode, "An operational Capability belonging to Capability Domain BAABD01")
    }
}
Group(GroupingBreaBUniqueCode, "Business Area B"){
    Strategy_Capability(CapabilityDomain02UniqueCode, "A Capability Domain belonging the Grouping Area B") {
      Strategy_Capability(OperationalCapability02UniqueCode, "An operational Capability belonging to Capability Domain BAABD01")
    }
}
@enduml`;

type ArchimateMappingEntry = {
  name: string;
  plantUMLKeyword: string;
  category?: string;
  description?: string;
};

const ARCHIMATE_MAPPING_PATHS = [
  path.resolve(MODULE_DIR, '../documentation/mapping_archimate2plantuml.json'),
  path.resolve(MODULE_DIR, '../../documentation/mapping_archimate2plantuml.json'),
  path.resolve(MODULE_DIR, '../../../documentation/mapping_archimate2plantuml.json'),
  path.resolve(process.cwd(), 'documentation/mapping_archimate2plantuml.json'),
];

const ARCHIMATE_MAPPING_DATA = await (async () => {
  for (const candidate of ARCHIMATE_MAPPING_PATHS) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as ArchimateMappingEntry[];
      logToConsole('debug', `Loaded ArchiMate mapping from ${candidate}`);
      return parsed;
    } catch {
      // Continue to next candidate
    }
  }

  logToConsole(
    'warning',
    'Unable to load mapping_archimate2plantuml.json from any known location. Static mapping resource will be empty.',
  );
  return [] as ArchimateMappingEntry[];
})();

const ARCHIMATE_RELATIONSHIP_REFERENCE_SOURCE = `@startuml

!global $ARCH_LOCAL = %true()
!global $ARCH_DEBUG = %false()

    !include <archimate/Archimate>
    '!theme archimate-alternate from <archimate/themes>
    '!theme archimate-handwriting from <archimate/themes>
    '!theme archimate-lowsaturation from <archimate/themes>
    '!theme archimate-saturated from <archimate/themes>
    '!theme archimate-standard from <archimate/themes>


skinparam nodesep 4
left to right direction

!procedure Draw($name, $raw, $rawOverride=\"\")
    !if ($rawOverride == \"\")
        !$showRaw = $raw
    !else
        !$showRaw = $rawOverride
    !endif
    label $name
    label \"$showRaw\" <<mono>> as a$name
    $name $raw a$name
!endprocedure

hide stereotype
<style>
.mono {
    FontName monospaced
}
</style>

legend left
Usage:
**Rel_XXX(from, to, label)**
or by using raw arrows: A **arrow** B
end legend

rectangle \"Other Relationships\" as other {
    circle \"Junction Or\\ncircle id\" <<junction>> as c1
    circle #black \"Junction And\\ncircle #black id\" <<junction>> as c2
    c1 -[hidden]- c2
    Draw(Specialisation, \"--|>\")
}

rectangle \"Dynamic Dependencies\" as dynamic {
    Draw(Flow, \"..>>\")
    Draw(Triggering, \"-->>\")
}

rectangle \"Dependency Relationships\" as dependency {
    Draw(Association_dir, \"--\\\\\", \"--\\\\\\\\\")
    Draw(Association, \" --\")
    Draw(Influence, \"..>\")
    Draw(Access_rw, \"<-[dotted]->\")
    Draw(Access_w, \"-[dotted]->\")
    Draw(Access_r, \"<-[dotted]-\")
    Draw(Access, \"-[dotted]-\")
    Draw(Serving, \"-->\")
}

rectangle \"Structural Relationships\" as structural {
    Draw(Realisation, \"-[dotted]-|>\")
    Draw(Assignment, \"@-->>\")
    Draw(Aggregation, \"o--\")
    Draw(Composition, \"*--\")
}
@enduml`;

const ARCHIMATE_RELATIONSHIP_LEGEND_BODY = ARCHIMATE_RELATIONSHIP_REFERENCE_SOURCE.split('\n')
  .filter((_, index, array) => index !== 0 && index !== array.length - 1)
  .join('\n')
  .trim();

const ARCHIMATE_REFERENCE_PROMPT_BODY = `# ArchiMate Elements & Relationship Reference

Use this canonical sample from the ArchiMate PlantUML stdlib to stay 100% compliant when generating diagrams.

## Elements (from Archimate-Elements.wsd)
\`\`\`plantuml
${ARCHIMATE_ELEMENTS_REFERENCE_SOURCE}
\`\`\`

## Relationship Legend
\`\`\`plantuml
${ARCHIMATE_RELATIONSHIP_REFERENCE_SOURCE}
\`\`\`
`;

const PROMPTS: PromptDefinition[] = [
  {
    name: 'plantuml_error_handling',
    title: 'PlantUML Error Handling Guide',
    description: 'Guidelines for handling PlantUML syntax errors and implementing auto-fix workflows.',
    arguments: [
      {
        name: 'error_message',
        description: 'Latest PlantUML error message (optional).',
      },
      {
        name: 'plantuml_code',
        description: 'PlantUML input that triggered the error (optional).',
      },
    ],
    template: (args = {}) => {
      const contextParts: string[] = [];

      if (args.error_message) {
        contextParts.push(`Latest PlantUML error message:\n> ${args.error_message}`);
      }

      if (args.plantuml_code) {
        contextParts.push(`PlantUML input that triggered the error:\n\`\`\`plantuml\n${args.plantuml_code}\n\`\`\``);
      }

      const context = contextParts.length > 0 ? `${contextParts.join('\n\n')}\n\n---\n\n` : '';
      return `${context}${PLANTUML_ERROR_PROMPT_BODY}`;
    },
  },
  {
    name: 'capability_landscape_template',
    title: 'Capability Landscape ArchiMate Template',
    description: 'Starter PlantUML snippet for generating capability landscapes using ArchiMate shapes.',
    template: () => {
      return `Use the following PlantUML snippet as a baseline for capability landscape diagrams:

\`\`\`plantuml
${DEFAULT_CAPABILITY_LANDSCAPE_SNIPPET}
\`\`\`

- Update \`Group(...)\` labels to reflect your business areas or groupings.
- Add or remove \`Strategy_Capability\` blocks to represent capability domains and operational capabilities.
- Keep \`$special=%true()\` on capability nodes when you want rounded special shapes.
- You can include additional ArchiMate elements by referencing the \`<archimate/Archimate>\` library.`;
    },
  },
  {
    name: 'archimate_elements_reference',
    title: 'ArchiMate Elements & Relationship Guide',
    description:
      'Full ArchiMate element catalog from the stdlib plus the official relationship legend to ensure compliant diagrams.',
    template: () => ARCHIMATE_REFERENCE_PROMPT_BODY,
  },
];

type ResourceDefinition = {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  text: string;
};

const STATIC_RESOURCES: ResourceDefinition[] = [
  {
    uri: 'resource://plantuml/server-guide',
    name: 'server-guide',
    title: 'PlantUML MCP Server Guide',
    description: 'Overview of prompts, tools, and usage guidelines exposed by the PlantUML MCP server.',
    mimeType: 'text/markdown',
    text: `# PlantUML MCP Server Guide

This MCP server exposes:

- **Prompts** for troubleshooting PlantUML validation errors
- **Tools** to encode, decode, and render PlantUML diagrams
- **Structured outputs** aligned with the 2025-06-18 MCP schema

## Prompts

Use \`plantuml_error_handling\` to review syntax errors and retry strategies. The prompt accepts optional arguments:

- \`error_message\`
- \`plantuml_code\`

## Tools

| Tool | Description | Key Arguments |
| ---- | ----------- | ------------- |
| \`generate_plantuml_diagram\` | Validate and render PlantUML input | \`plantuml_code\`, optional \`format\` (\`svg\` or \`png\`) |
| \`encode_plantuml\` | Encode text for PlantUML servers | \`plantuml_code\` |
| \`decode_plantuml\` | Decode an encoded payload | \`encoded_string\` |

All tools provide structured content describing the outcome or failure details.

## Completion

The server offers completions for resource URIs; start typing \`resource://plantuml/\` when selecting resources to see suggestions.

## Logging

Clients can configure log forwarding through \`logging/setLevel\`. Warnings and above are emitted by default when enabled.
`,
  },
  {
    uri: 'resource://plantuml/archimate-mapping',
    name: 'archimate-mapping',
    title: 'ArchiMate ↔ PlantUML Mapping',
    description:
      'Lookup table between ArchiMate language concepts and their PlantUML ArchiMate macros, sourced from documentation/mapping_archimate2plantuml.json.',
    mimeType: 'text/markdown',
    text: renderArchimateMappingMarkdown(ARCHIMATE_MAPPING_DATA),
  },
];

function encodePlantUML(plantuml: string): string {
  return plantumlEncoder.encode(plantuml);
}

function decodePlantUML(encoded: string): string {
  return plantumlEncoder.decode(encoded);
}

function renderArchimateMappingMarkdown(entries: ArchimateMappingEntry[]): string {
  const header = [
    '# ArchiMate to PlantUML Mapping',
    '',
    'Source: `documentation/mapping_archimate2plantuml.json`.',
    '',
  ];

  if (entries.length === 0) {
    return `${header.join('\n')}_Mapping data unavailable. Please ensure the JSON file exists on the server._\n`;
  }

  const categoryMap = new Map<string, ArchimateMappingEntry[]>();
  entries.forEach((entry) => {
    const category = entry.category?.trim() || 'Uncategorized';
    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }
    categoryMap.get(category)?.push(entry);
  });

  const parts = [...header];
  const sortedCategories = Array.from(categoryMap.keys()).sort((a, b) => a.localeCompare(b));

  sortedCategories.forEach((category) => {
    parts.push(`## ${category}`);
    parts.push('');

    const records = (categoryMap.get(category) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    records.forEach((record) => {
      const description = record.description?.trim();
      parts.push(`- **${record.name}** → \`${record.plantUMLKeyword}\``);
      if (description) {
        parts.push(`  - ${description}`);
      }
    });

    parts.push('');
  });

  return parts.join('\n');
}

function isValidAuthorizationHeader(header: string | undefined | null): boolean {
  if (!MCP_API_KEY) {
    return true;
  }
  return header === `Bearer ${MCP_API_KEY}`;
}

function unauthorizedResponse() {
  return {
    content: [{ type: 'text', text: 'Unauthorized: Invalid or missing authorization header.' }],
    isError: true,
  } as const;
}

function extractAuthorizationHeader(request: unknown): string | undefined {
  if (!request || typeof request !== 'object') {
    return undefined;
  }

  const headers = (request as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  const authorization = (headers as Record<string, unknown>).authorization;
  return typeof authorization === 'string' ? authorization : undefined;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value[value.length - 1];
  }

  return value;
}

function getAuthorizationHeader(req: IncomingMessage): string | undefined {
  return getHeaderValue(req.headers.authorization);
}

function getSessionIdHeader(req: IncomingMessage): string | undefined {
  return getHeaderValue(req.headers['mcp-session-id'] as string | string[] | undefined);
}

function ensureHttpCorsHeaders(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  res.setHeader('Vary', 'Origin');
}

function sendJsonError(res: ServerResponse, statusCode: number, message: string, code = -32000) {
  if (res.headersSent) {
    res.end();
    return;
  }

  res
    .writeHead(statusCode, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function isInitializationPayload(payload: unknown): boolean {
  if (Array.isArray(payload)) {
    return payload.some((entry) => isInitializeRequest(entry));
  }

  return isInitializeRequest(payload);
}

type StoredDiagramInfo = {
  fileName: string;
  filePath: string;
  publicUrl: string;
};

async function persistDiagramToSharedStorage(content: Buffer, format: string): Promise<StoredDiagramInfo | undefined> {
  if (!PUBLIC_FILE_BASE_URL) {
    return undefined;
  }

  try {
    await fs.mkdir(GENERATED_FILES_DIR, { recursive: true });
    const fileName = `${randomUUID()}.${format}`;
    const filePath = path.join(GENERATED_FILES_DIR, fileName);
    await fs.writeFile(filePath, content);
    const publicUrl = `${PUBLIC_FILE_BASE_URL}/${fileName}`;
    return { fileName, filePath, publicUrl };
  } catch (error) {
    logToConsole('warning', 'Failed to persist generated diagram to shared storage', error);
    return undefined;
  }
}

type CapabilityNode = {
  code?: string;
  label: string;
};

type CapabilityDomain = CapabilityNode & {
  capabilities?: CapabilityNode[];
};

type CapabilityGrouping = CapabilityNode & {
  capability_domains?: CapabilityDomain[];
};

function sanitizeIdentifier(value: string, fallbackPrefix: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '');
  if (normalized) {
    return normalized;
  }
  return `${fallbackPrefix}${randomUUID().replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}`;
}

function ensureIdentifier(candidate: unknown, fallbackLabel: string, fallbackPrefix: string): string {
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return sanitizeIdentifier(candidate.trim(), fallbackPrefix);
  }
  if (fallbackLabel.trim().length > 0) {
    return sanitizeIdentifier(fallbackLabel, fallbackPrefix);
  }
  return sanitizeIdentifier('', fallbackPrefix);
}

function buildCapabilityLandscapeSnippet(groupings: CapabilityGrouping[]): string {
  const lines: string[] = [
    '@startuml',
    '!theme archimate-standard from <archimate/themes>',
    '',
    '!include <archimate/Archimate>',
    '',
  ];

  groupings.forEach((group, groupIndex) => {
    const groupLabel = group.label?.trim() || `Grouping ${groupIndex + 1}`;
    const groupId = ensureIdentifier(group.code, groupLabel, `Grouping${groupIndex + 1}`);
    lines.push(`Group(${groupId}, "${groupLabel}"){`);

    (group.capability_domains ?? []).forEach((domain, domainIndex) => {
      const domainLabel = domain.label?.trim() || `Capability Domain ${domainIndex + 1}`;
      const domainId = ensureIdentifier(domain.code, domainLabel, `CapabilityDomain${groupIndex + 1}${domainIndex + 1}`);
      lines.push(`    Strategy_Capability(${domainId}, "${domainLabel}") {`);

      (domain.capabilities ?? []).forEach((capability, capabilityIndex) => {
        const capabilityLabel = capability.label?.trim() || `Operational Capability ${capabilityIndex + 1}`;
        const capabilityId = ensureIdentifier(
          capability.code,
          capabilityLabel,
          `OperationalCapability${groupIndex + 1}${domainIndex + 1}${capabilityIndex + 1}`,
        );
        lines.push(`      Strategy_Capability(${capabilityId}, "${capabilityLabel}")`);
      });

      lines.push('    }');
    });

    lines.push('}');
  });

  lines.push('@enduml');
  return lines.join('\n');
}

class PlantUMLMCPServer {
  private server: Server;
  private defaultAuthorization?: string;
  private clientLogLevel?: LogLevel;
  private supportsCompletions = false;

  constructor() {
    this.server = new Server({
      name: 'plantuml-server',
      title: 'PlantUML MCP Server',
      version: SERVER_VERSION,
    });

    this.server.registerCapabilities({
      tools: {},
      prompts: {},
      resources: {},
      completions: {},
      logging: {},
    });

    this.clientLogLevel = undefined;

    const serverWithCapabilities = this.server as unknown as {
      getCapabilities: () => Record<string, unknown>;
    };
    const originalGetCapabilities = serverWithCapabilities.getCapabilities.bind(this.server);
    serverWithCapabilities.getCapabilities = () => {
      const base = originalGetCapabilities();
      const capabilities: Record<string, unknown> = { ...base };

      if (base.prompts) {
        capabilities.prompts = { listChanged: false };
      }
      if (base.resources) {
        capabilities.resources = { subscribe: false, listChanged: false };
      }
      if (base.tools) {
        capabilities.tools = { listChanged: false };
      }
      if (base.logging) {
        capabilities.logging = base.logging;
      }
      if (this.supportsCompletions) {
        capabilities.completions = {};
      }

      return capabilities;
    };

    this.server.oninitialized = () => {
      this.log(
        'debug',
        'MCP initialization completed with client capabilities: ' +
          JSON.stringify(this.server.getClientCapabilities()),
      );
    };

    this.setupToolHandlers();
    this.setupPromptHandlers();
    this.setupResourceHandlers();
    this.setupCompletionHandlers();
    this.setupLoggingHandlers();
  }

  private requireString(value: unknown, path: string): string {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    throw new Error(`Expected a non-empty string for ${path}`);
  }

  private optionalString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    return undefined;
  }

  private indentLine(text: string, indent: number): string {
    const depth = Number.isFinite(indent) && indent > 0 ? indent : 0;
    return `${'  '.repeat(depth)}${text}`;
  }

  private registerArchimateIdentifiers(
    map: Map<string, string>,
    resolvedId: string,
    ...keys: (string | undefined)[]
  ) {
    if (!resolvedId) {
      return;
    }

    const registerKey = (key: string | undefined) => {
      if (typeof key !== 'string') {
        return;
      }
      const trimmed = key.trim();
      if (!trimmed) {
        return;
      }
      map.set(trimmed.toLowerCase(), resolvedId);
    };

    registerKey(resolvedId);
    keys.forEach((key) => registerKey(key));
  }

  private buildArchimateElementLines(
    input: unknown,
    identifierMap: Map<string, string>,
    path: string,
    indent = 0,
  ): string[] {
    if (!Array.isArray(input)) {
      return [];
    }

    const lines: string[] = [];

    input.forEach((entry, index) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          lines.push(this.indentLine(trimmed, indent));
        }
        return;
      }

      if (!entry || typeof entry !== 'object') {
        throw new Error(`${path}[${index}] must be an object or string describing an ArchiMate element.`);
      }

      const record = entry as Record<string, unknown>;
      const rawLine = this.optionalString(record.raw ?? record.line);
      if (rawLine) {
        const identifier = this.optionalString(record.identifier ?? record.id ?? record.code ?? record.alias);
        if (identifier) {
          this.registerArchimateIdentifiers(identifierMap, identifier, identifier);
        }
        lines.push(this.indentLine(rawLine, indent));
        return;
      }

      const macro = this.requireString(record.macro ?? record.type, `${path}[${index}].macro`);
      const label = this.requireString(record.label ?? record.name, `${path}[${index}].label`);
      const detail = this.optionalString(record.description ?? record.detail);
      const aliasCandidate = this.optionalString(record.id ?? record.code ?? record.identifier ?? record.alias);

      const elementId = ensureIdentifier(aliasCandidate, label, `ArchimateElement${index + 1}`);
      this.registerArchimateIdentifiers(identifierMap, elementId, aliasCandidate, label);

      const args = [elementId, JSON.stringify(label)];
      if (detail) {
        args.push(JSON.stringify(detail));
      }
      const extra = this.optionalString(record.extra ?? record.options);
      const elementLine = `${macro}(${args.join(', ')}${extra ? `, ${extra}` : ''})`;
      lines.push(this.indentLine(elementLine, indent));

      const note = this.optionalString(record.note ?? record.annotation);
      if (note) {
        lines.push(this.indentLine(`note right of ${elementId}`, indent));
        note.split('\n').forEach((noteLine) => {
          lines.push(this.indentLine(noteLine, indent + 1));
        });
        lines.push(this.indentLine('end note', indent));
      }
    });

    return lines;
  }

  private buildArchimateGroupLines(
    input: unknown,
    identifierMap: Map<string, string>,
    path: string,
    indent = 0,
  ): string[] {
    if (!Array.isArray(input)) {
      return [];
    }

    const lines: string[] = [];

    input.forEach((entry, index) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          lines.push(this.indentLine(trimmed, indent));
        }
        return;
      }

      if (!entry || typeof entry !== 'object') {
        throw new Error(`${path}[${index}] must be an object or string describing an ArchiMate boundary/group.`);
      }

      const record = entry as Record<string, unknown>;
      const rawLine = this.optionalString(record.raw ?? record.line);
      if (rawLine) {
        lines.push(this.indentLine(rawLine, indent));
        return;
      }

      const label = this.requireString(record.label ?? record.name, `${path}[${index}].label`);
      const macro =
        this.optionalString(record.macro ?? record.kind ?? record.boundary ?? record.type ?? record.component) ??
        'Boundary';
      const aliasCandidate = this.optionalString(record.id ?? record.code ?? record.identifier ?? record.alias);
      const groupId = ensureIdentifier(aliasCandidate, label, `${macro}${index + 1}`);
      this.registerArchimateIdentifiers(identifierMap, groupId, aliasCandidate, label);

      lines.push(this.indentLine(`${macro}(${groupId}, ${JSON.stringify(label)}) {`, indent));

      const nestedElements = this.buildArchimateElementLines(
        record.elements,
        identifierMap,
        `${path}[${index}].elements`,
        indent + 1,
      );
      lines.push(...nestedElements);

      const nestedGroups = this.buildArchimateGroupLines(
        record.groups ?? record.children,
        identifierMap,
        `${path}[${index}].groups`,
        indent + 1,
      );
      lines.push(...nestedGroups);

      lines.push(this.indentLine('}', indent));
    });

    return lines;
  }

  private buildArchimateRelationshipLines(
    input: unknown,
    identifierMap: Map<string, string>,
    path: string,
  ): string[] {
    if (!Array.isArray(input)) {
      return [];
    }

    const lines: string[] = [];

    input.forEach((entry, index) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          lines.push(trimmed);
        }
        return;
      }

      if (!entry || typeof entry !== 'object') {
        throw new Error(`${path}[${index}] must be an object or string describing an ArchiMate relationship.`);
      }

      const record = entry as Record<string, unknown>;
      const rawLine = this.optionalString(record.raw ?? record.line);
      if (rawLine) {
        lines.push(rawLine);
        return;
      }

      const from = this.requireString(record.from ?? record.source ?? record.start, `${path}[${index}].from`);
      const to = this.requireString(record.to ?? record.target ?? record.end, `${path}[${index}].to`);
      const relationshipType = this.optionalString(record.type ?? record.relationship ?? record.rel);
      const label = this.optionalString(record.label ?? record.name ?? record.description);
      const arrow = this.optionalString(record.raw_arrow ?? record.arrow);
      const extra = this.optionalString(record.extra ?? record.options);
      const fromId = this.resolveArchimateIdentifier(identifierMap, from);
      const toId = this.resolveArchimateIdentifier(identifierMap, to);

      if (relationshipType) {
        const args = [fromId, toId];
        if (label) {
          args.push(JSON.stringify(label));
        }
        if (extra) {
          args.push(extra);
        }
        lines.push(`${relationshipType}(${args.join(', ')})`);
        return;
      }

      const suffix = label ? ` : ${label}` : '';
      lines.push(`${fromId} ${arrow ?? '-->'} ${toId}${suffix}`);
    });

    return lines;
  }

  private resolveArchimateIdentifier(identifierMap: Map<string, string>, raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error('Expected a valid ArchiMate identifier reference.');
    }

    const match = identifierMap.get(trimmed.toLowerCase());
    if (match) {
      return match;
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      return trimmed;
    }

    return sanitizeIdentifier(trimmed, 'ArchimateRef');
  }

  private buildArchimateDocument(options: {
    title?: string;
    layout?: string;
    theme?: string;
    includeLegend?: boolean;
    useLocalStdlib?: boolean;
    bodyLines: string[];
    extraBody?: string;
  }): string {
    const lines: string[] = ['@startuml'];

    lines.push(`!global $ARCH_LOCAL = ${options.useLocalStdlib ? '%true()' : '%false()'}`);
    lines.push('!global $ARCH_DEBUG = %false()');
    lines.push('!if ($ARCH_LOCAL == %false())');
    lines.push('    !include <archimate/Archimate>');
    lines.push("    '!theme archimate-alternate from <archimate/themes>");
    lines.push("    '!theme archimate-handwriting from <archimate/themes>");
    lines.push("    '!theme archimate-lowsaturation from <archimate/themes>");
    lines.push("    '!theme archimate-saturated from <archimate/themes>");
    lines.push("    '!theme archimate-standard from <archimate/themes>");
    lines.push('!else');
    lines.push('    !$LOCAL_FOLDER = "../dist/plantuml-stdlib/stdlib/archimate"');
    lines.push('    !include $LOCAL_FOLDER/Archimate.puml');
    lines.push("    '!theme archimate-alternate from $LOCAL_FOLDER/themes");
    lines.push("    '!theme archimate-handwriting from $LOCAL_FOLDER/themes");
    lines.push("    '!theme archimate-lowsaturation from $LOCAL_FOLDER/themes");
    lines.push("    '!theme archimate-saturated from $LOCAL_FOLDER/themes");
    lines.push("    '!theme archimate-standard from $LOCAL_FOLDER/themes");
    lines.push('!endif');

    if (options.theme) {
      lines.push(`!theme ${options.theme} from <archimate/themes>`);
    }

    lines.push('skinparam nodesep 4');

    const layout = options.layout?.toLowerCase();
    if (layout === 'top_down' || layout === 'top-down') {
      lines.push('LAYOUT_TOP_DOWN()');
    } else if (layout === 'sketch') {
      lines.push('LAYOUT_AS_SKETCH()');
    } else if (layout === 'bottom_up') {
      lines.push('LAYOUT_TOP_DOWN()');
    } else {
      lines.push('left to right direction');
    }

    if (options.title) {
      lines.push('');
      lines.push(`title ${options.title}`);
    }

    if (options.bodyLines.length > 0) {
      lines.push('');
      lines.push(...options.bodyLines);
    }

    if (options.extraBody) {
      lines.push('');
      lines.push(...options.extraBody.split('\n'));
    }

    if (options.includeLegend) {
      lines.push('');
      lines.push("' Relationship reference");
      lines.push(...ARCHIMATE_RELATIONSHIP_LEGEND_BODY.split('\n'));
    }

    lines.push('@enduml');
    return lines.join('\n');
  }

  private getClientLogLevelIndex(): number | undefined {
    if (!this.clientLogLevel) {
      return undefined;
    }
    const index = LOG_LEVELS.indexOf(this.clientLogLevel);
    return index === -1 ? undefined : index;
  }

  private shouldForwardLog(level: LogLevel): boolean {
    const clientIndex = this.getClientLogLevelIndex();
    if (clientIndex === undefined) {
      return false;
    }
    return LOG_LEVELS.indexOf(level) <= clientIndex;
  }

  private formatErrorForClient(error: unknown) {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    if (error === undefined) {
      return undefined;
    }

    return error;
  }

  private async forwardLog(level: LogLevel, message: string, error?: unknown, data?: unknown) {
    if (!this.shouldForwardLog(level)) {
      return;
    }

    const payload = data ?? (error ? { message, error: this.formatErrorForClient(error) } : { message });

    try {
      await this.server.sendLoggingMessage({
        level,
        logger: 'plantuml-mcp-server',
        data: payload,
      });
    } catch (sendError) {
      logToConsole('warning', 'Failed to forward log message to client', sendError);
    }
  }

  public log(level: LogLevel, message: string, error?: unknown, data?: unknown) {
    logToConsole(level, message, error);
    void this.forwardLog(level, message, error, data);
  }

  setDefaultAuthorization(authHeader?: string) {
    this.defaultAuthorization = authHeader;
  }

  private assertAuthorizedForRead(): void {
    if (!MCP_API_KEY) {
      return;
    }
    if (!this.defaultAuthorization) {
      this.log('warning', 'Unauthorized read request blocked due to missing authorization header.');
      throw new Error('Unauthorized: Invalid or missing authorization header.');
    }
  }

  async connect(transport: Transport) {
    await this.server.connect(transport);
  }

  async close() {
    await this.server.close();
  }

  onClose(handler: () => void) {
    this.server.onclose = handler;
  }

  onError(handler: (error: Error) => void) {
    this.server.onerror = handler;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      this.log('debug', 'ListTools request received');
      this.assertAuthorizedForRead();

      if (request.params?.cursor) {
        this.log('debug', `Ignoring unsupported tools cursor "${request.params.cursor}" (no additional pages).`);
        return { tools: [] };
      }

      return {
        tools: [
          {
            name: 'generate_plantuml_diagram',
            title: 'Generate PlantUML Diagram',
            description:
              'Generate a PlantUML diagram with syntax validation. Returns diagram URLs on success or structured errors for auto-fix workflows.',
            inputSchema: {
              type: 'object',
              properties: {
                plantuml_code: {
                  type: 'string',
                  description: 'PlantUML diagram code that will be validated and rendered.',
                },
                format: {
                  type: 'string',
                  enum: ['svg', 'png'],
                  default: 'svg',
                  description: 'Output image format.',
                },
              },
              required: ['plantuml_code'],
            },
            outputSchema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                format: { type: 'string', enum: ['svg', 'png'] },
                diagram_url: { type: 'string', format: 'uri' },
                markdown_embed: { type: 'string' },
                encoded_diagram: { type: 'string' },
                validation_failed: { type: 'boolean' },
                error_details: {
                  type: 'object',
                  properties: {
                    error_message: { type: 'string' },
                    error_line: { type: 'integer' },
                    problematic_code: { type: 'string' },
                    full_plantuml: { type: 'string' },
                    full_context: { type: 'string' },
                  },
                },
                retry_instructions: { type: 'string' },
                error_message: { type: 'string' },
              },
              required: ['success'],
            },
          },
          {
            name: 'generate_capability_landscape',
            title: 'Generate Capability Landscape',
            description:
              'Generate an ArchiMate-based capability landscape diagram using groups, capability domains, and operational capabilities.',
            inputSchema: {
              type: 'object',
              properties: {
                groupings: {
                  type: 'array',
                  description:
                    'Optional capability grouping definitions. If omitted, a default ArchiMate example is used.',
                  items: {
                    type: 'object',
                    properties: {
                      code: { type: 'string' },
                      label: { type: 'string' },
                      capability_domains: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            code: { type: 'string' },
                            label: { type: 'string' },
                            capabilities: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  code: { type: 'string' },
                                  label: { type: 'string' },
                                },
                                required: ['label'],
                              },
                            },
                          },
                          required: ['label'],
                        },
                      },
                    },
                    required: ['label'],
                  },
                },
                format: {
                  type: 'string',
                  enum: ['svg', 'png'],
                  default: 'svg',
                  description: 'Output image format.',
                },
              },
            },
            outputSchema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                format: { type: 'string', enum: ['svg', 'png'] },
                diagram_url: { type: 'string', format: 'uri' },
                markdown_embed: { type: 'string' },
                encoded_diagram: { type: 'string' },
                remote_plantuml_url: { type: 'string', format: 'uri' },
                shared_storage: {
                  type: 'object',
                  properties: {
                    filename: { type: 'string' },
                    file_path: { type: 'string' },
                    public_url: { type: 'string', format: 'uri' },
                  },
                },
                error_message: { type: 'string' },
              },
              required: ['success'],
            },
          },
          {
            name: 'encode_plantuml',
            title: 'Encode PlantUML',
            description: 'Encode PlantUML code for usage in URLs or PlantUML servers.',
            inputSchema: {
              type: 'object',
              properties: {
                plantuml_code: {
                  type: 'string',
                  description: 'PlantUML diagram code to encode.',
                },
              },
              required: ['plantuml_code'],
            },
            outputSchema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                encoded: { type: 'string' },
                svg_url: { type: 'string', format: 'uri' },
                png_url: { type: 'string', format: 'uri' },
                error_message: { type: 'string' },
              },
              required: ['success'],
            },
          },
          {
            name: 'decode_plantuml',
            title: 'Decode PlantUML',
            description: 'Decode an encoded PlantUML string back to PlantUML source.',
            inputSchema: {
              type: 'object',
              properties: {
                encoded_string: {
                  type: 'string',
                  description: 'Encoded PlantUML string to decode.',
                },
              },
              required: ['encoded_string'],
            },
            outputSchema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                decoded: { type: 'string' },
                error_message: { type: 'string' },
              },
              required: ['success'],
            },
          },
          {
            name: 'generate_archimate_diagram',
            title: 'Generate ArchiMate Diagram',
            description:
              'Generate an ArchiMate-compliant PlantUML diagram using stdlib templates. Provide structured elements/groups/relationships or a raw body snippet.',
            inputSchema: {
              type: 'object',
              properties: {
                diagram_body: {
                  type: 'string',
                  description: 'Optional PlantUML body (without @startuml/@enduml) that will be wrapped in the ArchiMate template.',
                },
                title: {
                  type: 'string',
                  description: 'Optional diagram title injected into the template.',
                },
                layout: {
                  type: 'string',
                  enum: ['left_to_right', 'top_down', 'sketch'],
                  description: 'Preferred layout helper. Defaults to left_to_right.',
                },
                theme: {
                  type: 'string',
                  description: 'Optional ArchiMate theme name (e.g., archimate-alternate).',
                },
                include_relationship_legend: {
                  type: 'boolean',
                  description: 'Set to true to append the official ArchiMate relationship legend block.',
                },
                include_elements_reference: {
                  type: 'boolean',
                  description: 'When true (and no custom data provided), use the Archimate-Elements.wsd sample as-is.',
                },
                use_local_stdlib: {
                  type: 'boolean',
                  description: 'Force the template to reference the local stdlib copy instead of the remote include.',
                },
                extra_body: {
                  type: 'string',
                  description: 'Additional PlantUML lines appended after autogenerated elements (before relationships).',
                },
                groups: {
                  type: 'array',
                  description: 'Optional boundary/group definitions for nesting elements.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      code: { type: 'string' },
                      label: { type: 'string' },
                      macro: {
                        type: 'string',
                        description: 'Boundary macro (Boundary, Group, etc.). Defaults to Boundary.',
                      },
                      elements: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            code: { type: 'string' },
                            macro: { type: 'string' },
                            label: { type: 'string' },
                            description: { type: 'string' },
                            note: { type: 'string' },
                            raw: { type: 'string' },
                          },
                          required: ['label'],
                        },
                      },
                      groups: {
                        type: 'array',
                        description: 'Nested groups/boundaries.',
                        items: { type: 'object' },
                      },
                      raw: { type: 'string' },
                    },
                    required: ['label'],
                  },
                },
                elements: {
                  type: 'array',
                  description: 'Flat list of ArchiMate elements to render when no groups are provided.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      code: { type: 'string' },
                      macro: {
                        type: 'string',
                        description: 'ArchiMate macro (Business_Actor, Application_Service, etc.).',
                      },
                      label: { type: 'string' },
                      description: { type: 'string' },
                      note: { type: 'string' },
                      extra: { type: 'string', description: 'Raw suffix appended to the macro call.' },
                      raw: {
                        type: 'string',
                        description: 'Full PlantUML line to insert verbatim (use when macro is already composed).',
                      },
                    },
                    required: ['label'],
                  },
                },
                relationships: {
                  type: 'array',
                  description: 'Optional ArchiMate relationships between elements.',
                  items: {
                    type: 'object',
                    properties: {
                      from: { type: 'string' },
                      to: { type: 'string' },
                      type: {
                        type: 'string',
                        description: 'Rel_XXX macro to apply (Rel_Association, Rel_Triggering, etc.).',
                      },
                      label: { type: 'string' },
                      raw_arrow: {
                        type: 'string',
                        description: 'Override arrow syntax (e.g., \"..>\"). Used when type is omitted.',
                      },
                      raw: { type: 'string', description: 'Full PlantUML line to insert verbatim.' },
                    },
                    required: ['from', 'to'],
                  },
                },
                format: {
                  type: 'string',
                  enum: ['svg', 'png'],
                  default: 'svg',
                  description: 'Output image format.',
                },
              },
            },
            outputSchema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                format: { type: 'string', enum: ['svg', 'png'] },
                diagram_url: { type: 'string', format: 'uri' },
                markdown_embed: { type: 'string' },
                encoded_diagram: { type: 'string' },
                remote_plantuml_url: { type: 'string', format: 'uri' },
                shared_storage: {
                  type: 'object',
                  properties: {
                    filename: { type: 'string' },
                    file_path: { type: 'string' },
                    public_url: { type: 'string', format: 'uri' },
                  },
                },
                archimate_source: { type: 'string' },
                error_message: { type: 'string' },
              },
              required: ['success'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name } = request.params;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      this.log('debug', `CallTool request received: ${name}`);
      this.log('debug', `Request arguments: ${JSON.stringify(args)}`);

      const authorization = extractAuthorizationHeader(request) ?? this.defaultAuthorization;
      if (!isValidAuthorizationHeader(authorization)) {
        this.log('warning', `Unauthorized CallTool request blocked for tool ${name ?? '<unknown>'}.`);
        return unauthorizedResponse();
      }

      switch (name) {
        case 'generate_plantuml_diagram':
          return this.generateDiagram(args);
        case 'generate_capability_landscape':
          return this.generateCapabilityLandscape(args);
        case 'generate_archimate_diagram':
          return this.generateArchimateDiagram(args);
        case 'encode_plantuml':
          return this.encodePlantuml(args);
        case 'decode_plantuml':
          return this.decodePlantuml(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  private setupPromptHandlers() {
    this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      this.log('debug', 'ListPrompts request received');
      this.assertAuthorizedForRead();

      if (request.params?.cursor) {
        this.log('debug', `Ignoring unsupported prompts cursor "${request.params.cursor}" (no additional pages).`);
        return { prompts: [] };
      }

      return {
        prompts: PROMPTS.map(({ template, ...prompt }) => prompt),
      };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      this.log('debug', `GetPrompt request for ${request.params.name}`);
      this.assertAuthorizedForRead();
      const prompt = PROMPTS.find((candidate) => candidate.name === request.params.name);

      if (!prompt) {
        throw new Error(`Unknown prompt: ${request.params.name}`);
      }

      const args = request.params.arguments ?? {};
      const text = prompt.template(args);

      return {
        description: prompt.description,
        messages: [
          {
            role: 'assistant',
            content: {
              type: 'text',
              text,
            },
          },
        ],
      };
    });
  }

  private setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      this.log('debug', 'ListResources request received');
      this.assertAuthorizedForRead();

      if (request.params?.cursor) {
        this.log(
          'debug',
          `Ignoring unsupported resources cursor "${request.params.cursor}" (no additional pages).`,
        );
        return { resources: [] };
      }

      return {
        resources: STATIC_RESOURCES.map(({ text, ...metadata }) => metadata),
      };
    });

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      this.log('debug', 'ListResourceTemplates request received');
      this.assertAuthorizedForRead();

      if (request.params?.cursor) {
        this.log(
          'debug',
          `Ignoring unsupported resource template cursor "${request.params.cursor}" (no additional pages).`,
        );
      }

      return { resourceTemplates: [] };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      this.log('debug', `ReadResource request for ${uri}`);
      this.assertAuthorizedForRead();

      const resource = STATIC_RESOURCES.find((entry) => entry.uri === uri);
      if (!resource) {
        this.log('warning', `Resource not found: ${uri}`);
        const error = new Error(`Resource not found: ${uri}`) as Error & {
          code: number;
          data: { uri: string };
        };
        error.code = -32002;
        error.data = { uri };
        throw error;
      }

      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: resource.text,
          },
        ],
      };
    });
  }

  private setupCompletionHandlers() {
    this.supportsCompletions = true;
    this.server.setRequestHandler(CompleteRequestSchema, async (request) => {
      this.log('debug', `Completion request received for ${request.params.ref.type}`);

      const searchValue = request.params.argument?.value?.toLowerCase() ?? '';
      let values: string[] = [];
      let total = 0;
      let hasMore = false;

      if (request.params.ref.type === 'ref/resource') {
        const matches = STATIC_RESOURCES.filter((resource) =>
          resource.uri.toLowerCase().includes(searchValue),
        );
        total = matches.length;
        values = matches.slice(0, COMPLETION_MAX_RESULTS).map((resource) => resource.uri);
        hasMore = matches.length > values.length;
      }

      return {
        completion: {
          values,
          total,
          hasMore,
        },
      };
    });
  }

  private setupLoggingHandlers() {
    this.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      const newLevel = parseLogLevel(request.params.level, this.clientLogLevel ?? requestedLogLevel);
      this.clientLogLevel = newLevel;
      this.log('notice', `Client log level set to ${newLevel}`);
      return {};
    });
  }

  private normalizeCapabilityGroupings(raw: unknown): CapabilityGrouping[] | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      throw new Error('groupings must be an array of capability grouping objects.');
    }

    return raw.map((entry, groupIndex) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`groupings[${groupIndex}] must be an object.`);
      }
      const record = entry as Record<string, unknown>;
      const label = this.requireString(record.label ?? record.name, `groupings[${groupIndex}].label`);
      const group: CapabilityGrouping = {
        code: this.optionalString(record.code ?? record.id),
        label,
      };

      const domainsRaw = record.capability_domains ?? record.capabilities ?? record.capabilityDomains;
      if (Array.isArray(domainsRaw)) {
        group.capability_domains = domainsRaw.map((domainEntry, domainIndex) => {
          if (!domainEntry || typeof domainEntry !== 'object') {
            throw new Error(`groupings[${groupIndex}].capability_domains[${domainIndex}] must be an object.`);
          }
          const domainRecord = domainEntry as Record<string, unknown>;
          const domainLabel = this.requireString(
            domainRecord.label ?? domainRecord.name,
            `groupings[${groupIndex}].capability_domains[${domainIndex}].label`,
          );
          const domain: CapabilityDomain = {
            code: this.optionalString(domainRecord.code ?? domainRecord.id),
            label: domainLabel,
          };

          const capabilitiesRaw = domainRecord.capabilities ?? domainRecord.operational_capabilities;
          if (Array.isArray(capabilitiesRaw)) {
            domain.capabilities = capabilitiesRaw.map((capEntry, capabilityIndex) => {
              if (!capEntry || typeof capEntry !== 'object') {
                throw new Error(
                  `groupings[${groupIndex}].capability_domains[${domainIndex}].capabilities[${capabilityIndex}] must be an object.`,
                );
              }
              const capRecord = capEntry as Record<string, unknown>;
              const capabilityLabel = this.requireString(
                capRecord.label ?? capRecord.name,
                `groupings[${groupIndex}].capability_domains[${domainIndex}].capabilities[${capabilityIndex}].label`,
              );
              return {
                code: this.optionalString(capRecord.code ?? capRecord.id),
                label: capabilityLabel,
              };
            });
          }

          return domain;
        });
      }

      return group;
    });
  }

  private async validatePlantUMLSyntax(encoded: string, originalCode: string) {
    try {
      const validationUrl = `${PLANTUML_SERVER_URL}/txt/${encoded}`;
      const response = await fetch(validationUrl);
      const errorMessage = response.headers.get('x-plantuml-diagram-error');

      if (!errorMessage) {
        return { isValid: true };
      }

      const errorLineHeader = response.headers.get('x-plantuml-diagram-error-line');
      const fullTextOutput = await response.text();
      const lines = originalCode.split('\n');
      const lineNumber = errorLineHeader ? Number.parseInt(errorLineHeader, 10) : undefined;
      const problematicCode =
        lineNumber && lineNumber > 0 && lineNumber <= lines.length ? lines[lineNumber - 1]?.trim() ?? '' : '';

      this.log('debug', `Validation failed: ${errorMessage} at line ${lineNumber ?? 'unknown'}`);

      return {
        isValid: false as const,
        error: {
          message: errorMessage,
          line: Number.isNaN(lineNumber) ? undefined : lineNumber,
          problematic_code: problematicCode,
          full_plantuml: originalCode,
          full_context: fullTextOutput,
        },
      };
    } catch (error) {
      this.log('warning', 'Validation endpoint failed, falling back to generation-only flow.', error);
      return { isValid: true };
    }
  }

  private async generateDiagram(args: Record<string, unknown>) {
    const plantumlCode = typeof args.plantuml_code === 'string' ? args.plantuml_code : undefined;
    const format = typeof args.format === 'string' ? args.format : 'svg';

    if (!plantumlCode) {
      throw new Error('plantuml_code is required');
    }

    try {
      const encoded = encodePlantUML(plantumlCode);
      const validation = await this.validatePlantUMLSyntax(encoded, plantumlCode);

      if (!validation.isValid && validation.error) {
        const structuredContent = {
          success: false as const,
          validation_failed: true as const,
          error_details: {
            error_message: validation.error.message,
            error_line: validation.error.line,
            problematic_code: validation.error.problematic_code,
            full_plantuml: validation.error.full_plantuml,
            full_context: validation.error.full_context,
          },
          retry_instructions:
            'The PlantUML code has syntax errors. Please fix the errors and retry with corrected syntax.',
        };

        return {
          structuredContent,
          content: [
            {
              type: 'text',
              text: `PlantUML validation failed:\n\`\`\`json\n${JSON.stringify(structuredContent.error_details, null, 2)}\n\`\`\`\n\nRetry instructions: ${structuredContent.retry_instructions}`,
            },
          ],
          isError: true,
        };
      }

      const remoteDiagramUrl = `${PLANTUML_SERVER_URL}/${format}/${encoded}`;
      const response = await fetch(remoteDiagramUrl);

      if (!response.ok) {
        throw new Error(`PlantUML server returned ${response.status}: ${response.statusText}`);
      }

      const diagramBuffer = Buffer.from(await response.arrayBuffer());
      const storedDiagram = await persistDiagramToSharedStorage(diagramBuffer, format);
      const publicDiagramUrl = storedDiagram?.publicUrl ?? remoteDiagramUrl;
      const markdownEmbed = `![PlantUML Diagram](${publicDiagramUrl})`;

      const structuredContent = {
        success: true as const,
        format,
        diagram_url: publicDiagramUrl,
        markdown_embed: markdownEmbed,
        encoded_diagram: encoded,
        remote_plantuml_url: remoteDiagramUrl,
      } as Record<string, unknown>;

      if (storedDiagram) {
        structuredContent.shared_storage = {
          filename: storedDiagram.fileName,
          file_path: storedDiagram.filePath,
          public_url: storedDiagram.publicUrl,
        };
      }

      const contentParts = [
        'Successfully generated PlantUML diagram!',
        `**Public URL:**\n\`\`\`\n${publicDiagramUrl}\n\`\`\``,
        `**PlantUML server URL:**\n\`\`\`\n${remoteDiagramUrl}\n\`\`\``,
        `**Markdown embed:**\n\`\`\`markdown\n${markdownEmbed}\n\`\`\``,
      ];

      if (storedDiagram) {
        contentParts.splice(
          2,
          0,
          `Shared volume filename: \`${storedDiagram.fileName}\` (stored under ${GENERATED_FILES_DIR}).`,
        );
      }

      return {
        structuredContent,
        content: [
          {
            type: 'text',
            text: contentParts.join('\n\n'),
          },
        ],
      };
    } catch (error) {
      this.log('error', 'Error generating PlantUML diagram', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        structuredContent: {
          success: false,
          error_message: errorMessage,
        },
        content: [
          {
            type: 'text',
            text: `Error generating PlantUML diagram: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async generateArchimateDiagram(args: Record<string, unknown>) {
    const format = args.format === 'png' ? 'png' : 'svg';
    const includeLegend = args.include_relationship_legend === true;
    const includeElementsReference = args.include_elements_reference === true;
    const title = this.optionalString(args.title ?? args.diagram_title);
    const layout = this.optionalString(args.layout ?? args.orientation);
    const theme = this.optionalString(args.theme);
    const useLocalStdlib = args.use_local_stdlib === true;
    const extraBody = this.optionalString(args.extra_body ?? args.append_body ?? args.footer);
    const overrideBody = this.optionalString(args.diagram_body ?? args.archimate_body ?? args.body);

    let plantumlCode: string;

    if (overrideBody && overrideBody.trim().length > 0) {
      const trimmedBody = overrideBody.trim();
      if (trimmedBody.startsWith('@startuml')) {
        plantumlCode = trimmedBody;
      } else {
        plantumlCode = this.buildArchimateDocument({
          title,
          layout,
          theme,
          includeLegend,
          useLocalStdlib,
          bodyLines: trimmedBody.split('\n'),
          extraBody: extraBody ?? undefined,
        });
      }
    } else if (includeElementsReference) {
      plantumlCode = ARCHIMATE_ELEMENTS_REFERENCE_SOURCE;
    } else {
      const identifierMap = new Map<string, string>();
      const groupLines = this.buildArchimateGroupLines(
        args.groups ?? args.boundaries ?? args.areas,
        identifierMap,
        'groups',
      );
      const elementLines = this.buildArchimateElementLines(args.elements, identifierMap, 'elements');
      const relationshipLines = this.buildArchimateRelationshipLines(args.relationships, identifierMap, 'relationships');

      const bodyLines: string[] = [];

      if (groupLines.length > 0) {
        bodyLines.push(...groupLines);
      }

      if (elementLines.length > 0) {
        if (bodyLines.length > 0) {
          bodyLines.push('');
        }
        bodyLines.push(...elementLines);
      }

      if (extraBody) {
        const extraLines = extraBody.split('\n');
        if (extraLines.length > 0) {
          if (bodyLines.length > 0) {
            bodyLines.push('');
          }
          bodyLines.push(...extraLines);
        }
      }

      if (relationshipLines.length > 0) {
        if (bodyLines.length > 0) {
          bodyLines.push('');
        }
        bodyLines.push(...relationshipLines);
      }

      if (bodyLines.length === 0) {
        plantumlCode = ARCHIMATE_ELEMENTS_REFERENCE_SOURCE;
      } else {
        plantumlCode = this.buildArchimateDocument({
          title,
          layout,
          theme,
          includeLegend,
          useLocalStdlib,
          bodyLines,
        });
      }
    }

    const result = await this.generateDiagram({
      plantuml_code: plantumlCode,
      format,
    });

    if (result.structuredContent && typeof result.structuredContent === 'object') {
      (result.structuredContent as Record<string, unknown>).archimate_source = plantumlCode;
    }

    const sourceBlock = {
      type: 'text' as const,
      text: `**ArchiMate PlantUML Source:**\n\`\`\`plantuml\n${plantumlCode}\n\`\`\``,
    };

    if (Array.isArray(result.content)) {
      result.content.push(sourceBlock);
    } else {
      result.content = [sourceBlock];
    }

    return result;
  }

  private async generateCapabilityLandscape(args: Record<string, unknown>) {
    const format = args.format === 'png' ? 'png' : 'svg';
    let plantumlCode = DEFAULT_CAPABILITY_LANDSCAPE_SNIPPET;

    if ('groupings' in args && args.groupings !== undefined) {
      const groupings = this.normalizeCapabilityGroupings(args.groupings);
      if (groupings && groupings.length > 0) {
        plantumlCode = buildCapabilityLandscapeSnippet(groupings);
      }
    }

    return this.generateDiagram({
      plantuml_code: plantumlCode,
      format,
    });
  }

  private async encodePlantuml(args: Record<string, unknown>) {
    const plantumlCode = typeof args.plantuml_code === 'string' ? args.plantuml_code : undefined;

    if (!plantumlCode) {
      throw new Error('plantuml_code is required');
    }

    try {
      const encoded = encodePlantUML(plantumlCode);
      return {
        structuredContent: {
          success: true,
          encoded,
          svg_url: `${PLANTUML_SERVER_URL}/svg/${encoded}`,
          png_url: `${PLANTUML_SERVER_URL}/png/${encoded}`,
        },
        content: [
          {
            type: 'text',
            text: `**Encoded PlantUML:**\n\`\`\`\n${encoded}\n\`\`\`\n\n**Full SVG URL:**\n\`\`\`\n${PLANTUML_SERVER_URL}/svg/${encoded}\n\`\`\`\n\n**Full PNG URL:**\n\`\`\`\n${PLANTUML_SERVER_URL}/png/${encoded}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      this.log('error', 'Error encoding PlantUML', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        structuredContent: {
          success: false,
          error_message: errorMessage,
        },
        content: [
          {
            type: 'text',
            text: `Error encoding PlantUML: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async decodePlantuml(args: Record<string, unknown>) {
    const encodedString = typeof args.encoded_string === 'string' ? args.encoded_string : undefined;

    if (!encodedString) {
      throw new Error('encoded_string is required');
    }

    try {
      const decoded = decodePlantUML(encodedString);
      return {
        structuredContent: {
          success: true,
          decoded,
        },
        content: [
          {
            type: 'text',
            text: `**Decoded PlantUML:**\n\`\`\`plantuml\n${decoded}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      this.log('error', 'Error decoding PlantUML', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        structuredContent: {
          success: false,
          error_message: errorMessage,
        },
        content: [
          {
            type: 'text',
            text: `Error decoding PlantUML: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
}

async function startStreamableHttpServer() {
  type HttpSession = {
    transport: StreamableHTTPServerTransport;
    instance: PlantUMLMCPServer;
    authorization?: string;
  };

  const sessions = new Map<string, HttpSession>();

  const rejectUnauthorized = (res: ServerResponse, reason: string) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end(reason);
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!req?.url) {
        sendJsonError(res, 400, 'Invalid request');
        return;
      }

      const scheme = req.headers['x-forwarded-proto'] ?? 'http';
      const hostHeader = req.headers.host ?? `${MCP_HOST}:${MCP_PORT}`;
      const base = `${scheme}://${hostHeader}`;
      const requestUrl = new URL(req.url, base);

      if (req.method === 'OPTIONS' && requestUrl.pathname === MCP_HTTP_PATH) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'content-type, authorization, mcp-session-id',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Expose-Headers': 'mcp-session-id',
        });
        res.end();
        return;
      }

      if (requestUrl.pathname === MCP_HTTP_PATH) {
        if (req.method === 'POST') {
          ensureHttpCorsHeaders(res);

          const providedAuthorization = getAuthorizationHeader(req);
          const requestedSessionId = getSessionIdHeader(req);
          let session = requestedSessionId ? sessions.get(requestedSessionId) : undefined;

          if (requestedSessionId && !session) {
            req.resume();
            sendJsonError(res, 404, 'Session not found', -32001);
            return;
          }

          let effectiveAuthorization = providedAuthorization ?? session?.authorization;

          if (!session && !providedAuthorization && MCP_API_KEY) {
            req.resume();
            rejectUnauthorized(res, 'Unauthorized');
            return;
          }

          if (!isValidAuthorizationHeader(effectiveAuthorization)) {
            req.resume();
            rejectUnauthorized(res, 'Unauthorized');
            return;
          }

          let parsedBody: unknown | undefined;

          if (!session) {
            const parseResult = await (async (): Promise<{ success: true; body: unknown } | { success: false }> => {
              let parsedContentType: contentType.ParsedMediaType;
              try {
                parsedContentType = contentType.parse(req.headers['content-type'] ?? 'application/json');
              } catch (error) {
                sendJsonError(res, 400, 'Invalid Content-Type header');
                return { success: false };
              }

              if (parsedContentType.type !== 'application/json') {
                sendJsonError(res, 415, 'Unsupported Media Type: Content-Type must be application/json');
                return { success: false };
              }

              let rawBody: string;
              try {
                rawBody = await getRawBody(req, {
                  limit: MAXIMUM_MESSAGE_SIZE,
                  encoding: parsedContentType.parameters.charset ?? 'utf-8',
                });
              } catch (error) {
                sendJsonError(res, 400, 'Invalid request body');
                return { success: false };
              }

              try {
                return { success: true, body: JSON.parse(rawBody) };
              } catch (error) {
                sendJsonError(res, 400, 'Invalid JSON payload', -32700);
                return { success: false };
              }
            })();

            if (!parseResult.success) {
              return;
            }

            parsedBody = parseResult.body;

            if (!isInitializationPayload(parsedBody)) {
              sendJsonError(res, 400, 'Invalid Request: Initialization payload required for new session');
              return;
            }

            const serverInstance = new PlantUMLMCPServer();

            if (effectiveAuthorization) {
              serverInstance.setDefaultAuthorization(effectiveAuthorization);
            }

            const sessionRecord: HttpSession = {
              transport: new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: MCP_HTTP_ENABLE_JSON_RESPONSES,
                onsessioninitialized: (sessionId) => {
                  sessions.set(sessionId, sessionRecord);
                  serverInstance.log('info', `HTTP session started: ${sessionId}`);
                },
                onsessionclosed: (sessionId) => {
                  if (sessionId) {
                    sessions.delete(sessionId);
                  }
                  serverInstance.log('info', `HTTP session closed: ${sessionId ?? 'unknown'}`);
                },
              }),
              instance: serverInstance,
              authorization: effectiveAuthorization,
            };

            sessionRecord.instance.onClose(() => {
              const activeSessionId = sessionRecord.transport.sessionId;
              if (activeSessionId) {
                sessions.delete(activeSessionId);
              }
            });

            sessionRecord.instance.onError((error) => {
              serverInstance.log(
                'error',
                `Unhandled error in HTTP session ${sessionRecord.transport.sessionId ?? 'pending'}`,
                error,
              );
            });

            sessionRecord.transport.onerror = (error) => {
              serverInstance.log(
                'error',
                `Unhandled error in streamable HTTP transport ${sessionRecord.transport.sessionId ?? 'pending'}`,
                error,
              );
            };

            sessionRecord.transport.onclose = () => {
              const activeSessionId = sessionRecord.transport.sessionId;
              if (activeSessionId) {
                sessions.delete(activeSessionId);
              }
              void serverInstance.close().catch((error) => {
                logToConsole('warning', 'Error closing PlantUML session during shutdown', error);
              });
            };

            await serverInstance.connect(sessionRecord.transport);
            session = sessionRecord;
          }

          effectiveAuthorization = providedAuthorization ?? session?.authorization;

          if (session && effectiveAuthorization && !req.headers.authorization) {
            req.headers.authorization = effectiveAuthorization;
          }

          if (session && providedAuthorization && providedAuthorization !== session.authorization) {
            session.authorization = providedAuthorization;
            session.instance.setDefaultAuthorization(providedAuthorization);
          }

          if (!session) {
            sendJsonError(res, 500, 'Failed to initialize MCP session');
            return;
          }

          await session.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (req.method === 'GET' || req.method === 'DELETE') {
          ensureHttpCorsHeaders(res);

          const sessionId = getSessionIdHeader(req);
          if (!sessionId) {
            sendJsonError(res, 400, 'Bad Request: Mcp-Session-Id header is required');
            return;
          }

          const session = sessions.get(sessionId);
          if (!session) {
            sendJsonError(res, 404, 'Session not found', -32001);
            return;
          }

          const providedAuthorization = getAuthorizationHeader(req);
          const effectiveAuthorization = providedAuthorization ?? session.authorization;

          if (!isValidAuthorizationHeader(effectiveAuthorization)) {
            rejectUnauthorized(res, 'Unauthorized');
            return;
          }

          if (effectiveAuthorization && !req.headers.authorization) {
            req.headers.authorization = effectiveAuthorization;
          }

          if (providedAuthorization && providedAuthorization !== session.authorization) {
            session.authorization = providedAuthorization;
            session.instance.setDefaultAuthorization(providedAuthorization);
          }

          await session.transport.handleRequest(req, res);
          return;
        }

        req.resume();
        sendJsonError(res, 405, 'Method not allowed.');
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        return;
      }

      res.writeHead(404).end('Not found');
    } catch (error) {
      logToConsole('error', 'HTTP server error', error);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal server error');
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (error) => {
      logToConsole('error', 'HTTP server error', error);
      reject(error);
    });

    httpServer.listen(MCP_PORT, MCP_HOST, () => {
      logToConsole(
        'info',
        `PlantUML MCP server (HTTP transport) listening on http://${MCP_HOST}:${MCP_PORT}${MCP_HTTP_PATH}`,
      );
    });

    const shutdown = async () => {
      logToConsole('info', 'Shutdown signal received, closing HTTP server.');

      try {
        await Promise.all(
          Array.from(sessions.values()).map(async ({ transport, instance }) => {
            try {
              await transport.close();
            } catch (error) {
              logToConsole('warning', 'Error closing HTTP transport during shutdown', error);
            }

            try {
              await instance.close();
            } catch (error) {
              logToConsole('warning', 'Error closing HTTP session instance during shutdown', error);
            }
          }),
        );
      } finally {
        httpServer.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          resolve();
        });
      }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

async function startSseServer() {
  const sessions = new Map<
    string,
    {
      transport: SSEServerTransport;
      instance: PlantUMLMCPServer;
      authorization?: string;
    }
  >();

  const rejectUnauthorized = (res: ServerResponse, reason: string) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end(reason);
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end('Invalid request');
        return;
      }

      const scheme = req.headers['x-forwarded-proto'] ?? 'http';
      const hostHeader = req.headers.host ?? `${MCP_HOST}:${MCP_PORT}`;
      const base = `${scheme}://${hostHeader}`;
      const requestUrl = new URL(req.url, base);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'content-type, authorization',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === MCP_SSE_PATH) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        logToConsole('debug', `Incoming SSE GET from ${req.socket.remoteAddress} ${req.headers['user-agent'] ?? ''}`);

        if (!isValidAuthorizationHeader(req.headers.authorization)) {
          logToConsole('warning', 'Rejected SSE connection due to invalid or missing authorization header.');
          rejectUnauthorized(res, 'Unauthorized');
          return;
        }

        const serverInstance = new PlantUMLMCPServer();
        const absoluteMessagesEndpoint = new URL(MCP_SSE_MESSAGES_PATH, base).toString();
        serverInstance.log('debug', `Advertising SSE message endpoint ${absoluteMessagesEndpoint}`);
        const transport = new SSEServerTransport(absoluteMessagesEndpoint, res);

        serverInstance.setDefaultAuthorization(req.headers.authorization ?? undefined);

        sessions.set(transport.sessionId, {
          transport,
          instance: serverInstance,
          authorization: req.headers.authorization ?? undefined,
        });

        serverInstance.onClose(() => {
          sessions.delete(transport.sessionId);
          serverInstance.log('info', `SSE session closed: ${transport.sessionId}`);
        });

        serverInstance.onError((error) => {
          serverInstance.log('error', `Unhandled error in SSE session ${transport.sessionId}`, error);
        });

        await serverInstance.connect(transport);
        serverInstance.log('info', `SSE session started: ${transport.sessionId}`);
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === MCP_SSE_MESSAGES_PATH) {
        res.setHeader('Access-Control-Allow-Origin', '*');

        const sessionId = requestUrl.searchParams.get('sessionId');
        if (!sessionId) {
          res.writeHead(400).end('Missing sessionId');
          return;
        }

        const session = sessions.get(sessionId);
        if (!session) {
          req.resume();
          res.writeHead(404).end('Unknown session');
          return;
        }

        session.instance.log('debug', `Incoming SSE POST for session ${sessionId}`);

        const incomingAuthorization = req.headers.authorization ?? session.authorization;
        if (!isValidAuthorizationHeader(incomingAuthorization)) {
          session.instance.log('warning', `Rejected SSE message for session ${sessionId} due to invalid authorization header.`);
          rejectUnauthorized(res, 'Unauthorized');
          return;
        }

        if (incomingAuthorization !== session.authorization) {
          session.authorization = incomingAuthorization;
          session.instance.setDefaultAuthorization(incomingAuthorization);
        }

        await handleSsePostMessage(session, req, res);
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        return;
      }

      res.writeHead(404).end('Not found');
    } catch (error) {
      logToConsole('error', 'HTTP server error', error);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal server error');
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (error) => {
      logToConsole('error', 'HTTP server error', error);
      reject(error);
    });

    httpServer.listen(MCP_PORT, MCP_HOST, () => {
      logToConsole('info', `PlantUML MCP server (SSE transport) listening on http://${MCP_HOST}:${MCP_PORT}${MCP_SSE_PATH}`);
    });

    const shutdown = async () => {
      logToConsole('info', 'Shutdown signal received, closing server.');

      try {
        await Promise.all(
          Array.from(sessions.values()).map(async ({ instance }) => {
            try {
              await instance.close();
            } catch (error) {
              instance.log('warning', 'Error closing session during shutdown', error);
            }
          }),
        );
      } finally {
        httpServer.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          resolve();
        });
      }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

async function handleSsePostMessage(
  session: {
    transport: SSEServerTransport;
    instance: PlantUMLMCPServer;
    authorization?: string;
  },
  req: IncomingMessage,
  res: ServerResponse,
) {
  let body: string;

  try {
    const ct = contentType.parse(req.headers['content-type'] ?? 'application/json');
    if (ct.type !== 'application/json') {
      res.writeHead(400).end('Unsupported content-type');
      return;
    }

    body = await getRawBody(req, {
      limit: MAXIMUM_MESSAGE_SIZE,
      encoding: ct.parameters.charset ?? 'utf-8',
    });
  } catch (error) {
    session.instance.log('warning', 'Failed to read SSE message body', error);
    res.writeHead(400).end('Invalid request body');
    return;
  }

  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch (error) {
    session.instance.log('warning', 'Failed to parse SSE JSON payload', error);
    res.writeHead(400).end('Invalid JSON payload');
    return;
  }

  session.instance.log('debug', `SSE message received for session ${session.transport.sessionId}: ${body}`);

  try {
    await session.transport.handleMessage(message);
  } catch (error) {
    session.instance.log('error', 'Failed to handle SSE message', error);
    res.writeHead(500).end('Internal server error');
    return;
  }

  res.writeHead(202).end('Accepted');
}

async function start() {
  if (MCP_TRANSPORT === 'http') {
    await startStreamableHttpServer();
    return;
  }

  if (MCP_TRANSPORT === 'stdio') {
    const server = new PlantUMLMCPServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    server.log('info', 'PlantUML MCP server running on stdio transport');
    return;
  }

  if (MCP_TRANSPORT === 'sse') {
    await startSseServer();
    return;
  }

  throw new Error(`Unsupported MCP_TRANSPORT value: ${MCP_TRANSPORT}`);
}

start().catch((error) => {
  logToConsole('error', 'PlantUML MCP server failed to start', error);
  process.exitCode = 1;
});
