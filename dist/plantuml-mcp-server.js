#!/usr/bin/env node
import http from 'node:http';
import { URL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import * as contentType from 'content-type';
import plantumlEncoder from 'plantuml-encoder';
import getRawBody from 'raw-body';
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];
function normalizePath(path) {
    return path.startsWith('/') ? path : `/${path}`;
}
const requestedLogLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const logLevelIndex = LOG_LEVELS.indexOf(requestedLogLevel) !== -1 ? LOG_LEVELS.indexOf(requestedLogLevel) : LOG_LEVELS.indexOf('info');
function log(level, message, error) {
    if (LOG_LEVELS.indexOf(level) > logLevelIndex) {
        return;
    }
    const prefix = `[${level.toUpperCase()}]`;
    const text = `${prefix} ${message}`;
    if (level === 'error') {
        if (error instanceof Error && error.stack) {
            console.error(`${text}\n${error.stack}`);
        }
        else if (error) {
            console.error(`${text} ${String(error)}`);
        }
        else {
            console.error(text);
        }
        return;
    }
    if (level === 'warn') {
        console.warn(text);
    }
    else {
        console.info(text);
    }
}
const SERVER_VERSION = process.env.npm_package_version || '0.1.3';
const PLANTUML_SERVER_URL = process.env.PLANTUML_SERVER_URL || 'https://www.plantuml.com/plantuml';
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();
const MCP_HOST = process.env.MCP_HOST || '0.0.0.0';
const MCP_PORT = Number.parseInt(process.env.MCP_PORT || '3000', 10);
const MCP_SSE_PATH = normalizePath(process.env.MCP_SSE_PATH || '/sse');
const MCP_SSE_MESSAGES_PATH = normalizePath(process.env.MCP_SSE_MESSAGES_PATH || '/messages');
const MCP_API_KEY = process.env.MCP_API_KEY;
const MAXIMUM_MESSAGE_SIZE = '4mb';
log('info', `Log level set to ${requestedLogLevel}`);
if (MCP_API_KEY) {
    log('info', 'MCP API key authentication enabled.');
}
else {
    log('warn', 'MCP_API_KEY not set. Server will accept unauthenticated requests.');
}
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
const PROMPTS = [
    {
        name: 'plantuml_error_handling',
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
            const contextParts = [];
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
];
function encodePlantUML(plantuml) {
    return plantumlEncoder.encode(plantuml);
}
function decodePlantUML(encoded) {
    return plantumlEncoder.decode(encoded);
}
function isValidAuthorizationHeader(header) {
    if (!MCP_API_KEY) {
        return true;
    }
    return header === `Bearer ${MCP_API_KEY}`;
}
function unauthorizedResponse() {
    return {
        content: [{ type: 'text', text: 'Unauthorized: Invalid or missing authorization header.' }],
        isError: true,
    };
}
function extractAuthorizationHeader(request) {
    if (!request || typeof request !== 'object') {
        return undefined;
    }
    const headers = request.headers;
    if (!headers || typeof headers !== 'object') {
        return undefined;
    }
    const authorization = headers.authorization;
    return typeof authorization === 'string' ? authorization : undefined;
}
class PlantUMLMCPServer {
    server;
    constructor() {
        this.server = new Server({
            name: 'plantuml-server',
            version: SERVER_VERSION,
            capabilities: {
                tools: {},
                prompts: {},
            },
        });
        this.server.oninitialized = () => {
            log('debug', 'MCP initialization completed with client capabilities: ' + JSON.stringify(this.server.getClientCapabilities()));
        };
        this.setupToolHandlers();
        this.setupPromptHandlers();
    }
    async connect(transport) {
        await this.server.connect(transport);
    }
    async close() {
        await this.server.close();
    }
    onClose(handler) {
        this.server.onclose = handler;
    }
    onError(handler) {
        this.server.onerror = handler;
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            log('debug', 'ListTools request received');
            return {
                tools: [
                    {
                        name: 'generate_plantuml_diagram',
                        description: 'Generate a PlantUML diagram with syntax validation. Returns diagram URLs on success or structured errors for auto-fix workflows.',
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
                    },
                    {
                        name: 'encode_plantuml',
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
                    },
                    {
                        name: 'decode_plantuml',
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
                    },
                ],
            };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name } = request.params;
            const args = (request.params.arguments ?? {});
            log('debug', `CallTool request received: ${name}`);
            log('debug', `Request arguments: ${JSON.stringify(args)}`);
            const authorization = extractAuthorizationHeader(request);
            if (!isValidAuthorizationHeader(authorization)) {
                log('warn', `Unauthorized CallTool request blocked for tool ${name ?? '<unknown>'}.`);
                return unauthorizedResponse();
            }
            switch (name) {
                case 'generate_plantuml_diagram':
                    return this.generateDiagram(args);
                case 'encode_plantuml':
                    return this.encodePlantuml(args);
                case 'decode_plantuml':
                    return this.decodePlantuml(args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }
    setupPromptHandlers() {
        this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
            log('debug', 'ListPrompts request received');
            return {
                prompts: PROMPTS.map(({ template, ...prompt }) => prompt),
            };
        });
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            log('debug', `GetPrompt request for ${request.params.name}`);
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
    async validatePlantUMLSyntax(encoded, originalCode) {
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
            const problematicCode = lineNumber && lineNumber > 0 && lineNumber <= lines.length ? lines[lineNumber - 1]?.trim() ?? '' : '';
            log('debug', `Validation failed: ${errorMessage} at line ${lineNumber ?? 'unknown'}`);
            return {
                isValid: false,
                error: {
                    message: errorMessage,
                    line: Number.isNaN(lineNumber) ? undefined : lineNumber,
                    problematic_code: problematicCode,
                    full_plantuml: originalCode,
                    full_context: fullTextOutput,
                },
            };
        }
        catch (error) {
            log('warn', 'Validation endpoint failed, falling back to generation-only flow.', error);
            return { isValid: true };
        }
    }
    async generateDiagram(args) {
        const plantumlCode = typeof args.plantuml_code === 'string' ? args.plantuml_code : undefined;
        const format = typeof args.format === 'string' ? args.format : 'svg';
        if (!plantumlCode) {
            throw new Error('plantuml_code is required');
        }
        try {
            const encoded = encodePlantUML(plantumlCode);
            const validation = await this.validatePlantUMLSyntax(encoded, plantumlCode);
            if (!validation.isValid && validation.error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                validation_failed: true,
                                error_details: {
                                    error_message: validation.error.message,
                                    error_line: validation.error.line,
                                    problematic_code: validation.error.problematic_code,
                                    full_plantuml: validation.error.full_plantuml,
                                    full_context: validation.error.full_context,
                                },
                                retry_instructions: 'The PlantUML code has syntax errors. Please fix the errors and retry with corrected syntax.',
                            }, null, 2),
                        },
                    ],
                    isError: true,
                };
            }
            const diagramUrl = `${PLANTUML_SERVER_URL}/${format}/${encoded}`;
            const response = await fetch(diagramUrl);
            if (!response.ok) {
                throw new Error(`PlantUML server returned ${response.status}: ${response.statusText}`);
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully generated PlantUML diagram!\n\n**Embeddable ${format.toUpperCase()} URL:**\n\`\`\`\n${diagramUrl}\n\`\`\`\n\n**Markdown embed:**\n\`\`\`markdown\n![PlantUML Diagram](${diagramUrl})\n\`\`\``,
                    },
                ],
            };
        }
        catch (error) {
            log('error', 'Error generating PlantUML diagram', error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error generating PlantUML diagram: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
    async encodePlantuml(args) {
        const plantumlCode = typeof args.plantuml_code === 'string' ? args.plantuml_code : undefined;
        if (!plantumlCode) {
            throw new Error('plantuml_code is required');
        }
        try {
            const encoded = encodePlantUML(plantumlCode);
            return {
                content: [
                    {
                        type: 'text',
                        text: `**Encoded PlantUML:**\n\`\`\`\n${encoded}\n\`\`\`\n\n**Full SVG URL:**\n\`\`\`\n${PLANTUML_SERVER_URL}/svg/${encoded}\n\`\`\`\n\n**Full PNG URL:**\n\`\`\`\n${PLANTUML_SERVER_URL}/png/${encoded}\n\`\`\``,
                    },
                ],
            };
        }
        catch (error) {
            log('error', 'Error encoding PlantUML', error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error encoding PlantUML: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
    async decodePlantuml(args) {
        const encodedString = typeof args.encoded_string === 'string' ? args.encoded_string : undefined;
        if (!encodedString) {
            throw new Error('encoded_string is required');
        }
        try {
            const decoded = decodePlantUML(encodedString);
            return {
                content: [
                    {
                        type: 'text',
                        text: `**Decoded PlantUML:**\n\`\`\`plantuml\n${decoded}\n\`\`\``,
                    },
                ],
            };
        }
        catch (error) {
            log('error', 'Error decoding PlantUML', error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error decoding PlantUML: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
}
async function startSseServer() {
    const sessions = new Map();
    const rejectUnauthorized = (res, reason) => {
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
                log('debug', `Incoming SSE GET from ${req.socket.remoteAddress} ${req.headers['user-agent'] ?? ''}`);
                if (!isValidAuthorizationHeader(req.headers.authorization)) {
                    log('warn', 'Rejected SSE connection due to invalid or missing authorization header.');
                    rejectUnauthorized(res, 'Unauthorized');
                    return;
                }
                const serverInstance = new PlantUMLMCPServer();
                const absoluteMessagesEndpoint = new URL(MCP_SSE_MESSAGES_PATH, base).toString();
                log('debug', `Advertising SSE message endpoint ${absoluteMessagesEndpoint}`);
                const transport = new SSEServerTransport(absoluteMessagesEndpoint, res);
                sessions.set(transport.sessionId, {
                    transport,
                    instance: serverInstance,
                    authorization: req.headers.authorization ?? undefined,
                });
                serverInstance.onClose(() => {
                    sessions.delete(transport.sessionId);
                    log('info', `SSE session closed: ${transport.sessionId}`);
                });
                serverInstance.onError((error) => {
                    log('error', `Unhandled error in SSE session ${transport.sessionId}`, error);
                });
                await serverInstance.connect(transport);
                log('info', `SSE session started: ${transport.sessionId}`);
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
                    res.writeHead(404).end('Unknown session');
                    return;
                }
                log('debug', `Incoming SSE POST for session ${sessionId}`);
                const incomingAuthorization = req.headers.authorization ?? session.authorization;
                if (!isValidAuthorizationHeader(incomingAuthorization)) {
                    log('warn', `Rejected SSE message for session ${sessionId} due to invalid authorization header.`);
                    rejectUnauthorized(res, 'Unauthorized');
                    return;
                }
                await handleSsePostMessage(session, req, res);
                return;
            }
            if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
                res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                return;
            }
            res.writeHead(404).end('Not found');
        }
        catch (error) {
            log('error', 'HTTP server error', error);
            if (!res.headersSent) {
                res.writeHead(500).end('Internal server error');
            }
            else {
                res.end();
            }
        }
    });
    await new Promise((resolve, reject) => {
        httpServer.on('error', (error) => {
            log('error', 'HTTP server error', error);
            reject(error);
        });
        httpServer.listen(MCP_PORT, MCP_HOST, () => {
            log('info', `PlantUML MCP server (SSE transport) listening on http://${MCP_HOST}:${MCP_PORT}${MCP_SSE_PATH}`);
        });
        const shutdown = async () => {
            log('info', 'Shutdown signal received, closing server.');
            try {
                await Promise.all(Array.from(sessions.values()).map(async ({ instance }) => {
                    try {
                        await instance.close();
                    }
                    catch (error) {
                        log('warn', 'Error closing session during shutdown', error);
                    }
                }));
            }
            finally {
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
async function handleSsePostMessage(session, req, res) {
    let body;
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
    }
    catch (error) {
        log('warn', 'Failed to read SSE message body', error);
        res.writeHead(400).end('Invalid request body');
        return;
    }
    let message;
    try {
        message = JSON.parse(body);
    }
    catch (error) {
        log('warn', 'Failed to parse SSE JSON payload', error);
        res.writeHead(400).end('Invalid JSON payload');
        return;
    }
    log('debug', `SSE message received for session ${session.transport.sessionId}: ${body}`);
    if (message && typeof message === 'object') {
        message.headers = {
            authorization: req.headers.authorization ?? session.authorization,
        };
    }
    try {
        await session.transport.handleMessage(message);
    }
    catch (error) {
        log('error', 'Failed to handle SSE message', error);
        res.writeHead(500).end('Internal server error');
        return;
    }
    res.writeHead(202).end('Accepted');
}
async function start() {
    if (MCP_TRANSPORT === 'stdio') {
        const server = new PlantUMLMCPServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        log('info', 'PlantUML MCP server running on stdio transport');
        return;
    }
    if (MCP_TRANSPORT === 'sse') {
        await startSseServer();
        return;
    }
    throw new Error(`Unsupported MCP_TRANSPORT value: ${MCP_TRANSPORT}`);
}
start().catch((error) => {
    log('error', 'PlantUML MCP server failed to start', error);
    process.exitCode = 1;
});
//# sourceMappingURL=plantuml-mcp-server.js.map