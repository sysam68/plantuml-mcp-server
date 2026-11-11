# PlantUML MCP Server

Flexible Model Context Protocol (MCP) server that turns PlantUML snippets into shareable diagrams.  
All capabilities are exposed over **HTTP**, **Server-Sent Events (SSE)**, and **STDIO**, so you can plug the server into Claude Desktop, Flowise, or any other MCP-compatible runtime.

---

## Key Features
- 🧰 Tools: `generate_plantuml_diagram`, `generate_capability_landscape`, `generate_business_scenario`, `encode_plantuml`, `decode_plantuml`
- 🧾 Prompts: `plantuml_error_handling`, `archimate_macro_reference`, `capability_landscape_input_format`, `archimate_diagram_input_format`, `business_scenario_input_format`
- 📚 Static resources: `resource://plantuml/server-guide`, `resource://plantuml/archimate-mapping`
- 🔒 Optional Bearer authentication via `MCP_API_KEY`
- ☁️ Required `ob-file` export via signed download URLs (`OB_FILE_API_BASE_URL`)
- 🔐 Optional OIDC client-credentials flow for `ob-file` (`OB_FILE_OIDC_*`)

---

## Requirements
- Node.js **18+**
- npm **9+**

```bash
npm install
npm run build     # emits dist/plantuml-mcp-server.js
```

Use `npx plantuml-mcp-server` or `node dist/plantuml-mcp-server.js` once built.

---

## Transport Modes

| Mode | When to use | How to start |
| ---- | ----------- | ------------ |
| **HTTP** (default) | Direct REST-style integration, reverse proxies, health checks | `MCP_TRANSPORT=http node dist/plantuml-mcp-server.js` |
| **SSE** | Claude Desktop / Flowise over the network with push updates | `MCP_TRANSPORT=sse node dist/plantuml-mcp-server.js` |
| **STDIO** | Local CLI tools (npx, Claude Code CLI, Flowise managed process) | `MCP_TRANSPORT=stdio npx plantuml-mcp-server` |

### HTTP transport
```bash
MCP_TRANSPORT=http \
MCP_HOST=0.0.0.0 \
MCP_PORT=8765 \
MCP_HTTP_PATH=/mcp \
node dist/plantuml-mcp-server.js
```
- `POST /mcp` to initialize and send JSON-RPC payloads.
- `GET /mcp` and `DELETE /mcp` keep the streamable session alive.
- `GET /healthz` is available for readiness probes.
- Sample client settings: [`client_config_http.json`](client_config_http.json).

### SSE transport
```bash
MCP_TRANSPORT=sse \
MCP_HOST=0.0.0.0 \
MCP_PORT=8765 \
MCP_SSE_PATH=/sse \
MCP_SSE_MESSAGES_PATH=/messages \
node dist/plantuml-mcp-server.js
```
- Clients connect to `/sse` (GET) for events and POST JSON messages to `/messages`.
- Sample config for Claude Desktop / Flowise: [`client_config_sse.json`](client_config_sse.json).

### STDIO transport
```bash
MCP_TRANSPORT=stdio npx plantuml-mcp-server
# or run the compiled file directly
MCP_TRANSPORT=stdio node dist/plantuml-mcp-server.js
```
- Ideal for local experiments, `mcp` CLI, or Flowise nodes that spawn the binary.
- Example setups live in [`client_config_stdio.json`](client_config_stdio.json).

---

## Sample Client Configurations
- [`client_config_http.json`](client_config_http.json) – streamable HTTP (default `/mcp`)
- [`client_config_sse.json`](client_config_sse.json) – SSE + dedicated `messagesUrl`
- [`client_config_stdio.json`](client_config_stdio.json) – STDIO examples for `npx` and Flowise-managed processes

Drop these files into your MCP-aware client or copy the snippets as needed. Update hostnames, ports, and API keys to match your deployment.

---

## Environment Variables

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `LOG_LEVEL` | `info` | `emergency` → `debug` supported |
| `PLANTUML_SERVER_URL` | `https://www.plantuml.com/plantuml` | Upstream PlantUML renderer |
| `MCP_TRANSPORT` | `http` | `http`, `sse`, or `stdio` |
| `MCP_HOST` / `MCP_PORT` | `0.0.0.0` / `3000` | Bind address + port (HTTP/SSE) |
| `MCP_HTTP_PATH` | `/mcp` | HTTP JSON-RPC endpoint |
| `MCP_HTTP_ENABLE_JSON_RESPONSES` | `false` | Return JSON body when true (for debugging) |
| `MCP_SSE_PATH` | `/sse` | SSE stream endpoint |
| `MCP_SSE_MESSAGES_PATH` | `/messages` | Message ingestion endpoint |
| `MCP_API_KEY` | unset | Enables Bearer auth when provided |
| `OB_FILE_API_BASE_URL` | unset | `ob-file` management API base URL (for example `http://ob-file:8000`) |
| `OB_FILE_API_TOKEN` | unset | Bearer token used to call the `ob-file` management API |
| `OB_FILE_OIDC_DISCOVERY_URL` | unset | Authelia OIDC discovery URL used to obtain a service access token |
| `OB_FILE_OIDC_TOKEN_ENDPOINT` | unset | Optional direct token endpoint override (useful for internal service-to-service calls) |
| `OB_FILE_OIDC_CLIENT_ID` | unset | OIDC client identifier used by `mcp-plantuml` |
| `OB_FILE_OIDC_CLIENT_SECRET` | unset | OIDC client secret used by `mcp-plantuml` |
| `OB_FILE_OIDC_SCOPE` | `groups` | Scope requested during the client-credentials token request |
| `OB_FILE_OIDC_AUDIENCE` | `ob-file` | Audience requested during the client-credentials token request |
| `OB_FILE_OIDC_FORWARDED_PROTO` | unset | Optional `X-Forwarded-Proto` header for internal Authelia calls |
| `OB_FILE_OIDC_FORWARDED_HOST` | unset | Optional `X-Forwarded-Host` header for internal Authelia calls |
| `MCP_MAX_INLINE_IMAGE_BYTES` | `2097152` | Maximum rendered image size embedded directly in a tool result |
| `EXPOSE_PROMPT_AS_TOOL` | `false` | When `true`, every MCP prompt is also exposed as an MCP tool with the same name |
| `PLANTUML_MCP_SKIP_AUTO_START` | unset | When `true`, skips auto-start so scripts can import the server class without launching transports |

`OB_FILE_API_BASE_URL` is mandatory for all diagram generation tools. Rendered diagrams are uploaded through `ob-file` and the MCP response returns only the public `diagram_url` produced by `ob-file`. If `OB_FILE_OIDC_DISCOVERY_URL`, `OB_FILE_OIDC_CLIENT_ID`, and `OB_FILE_OIDC_CLIENT_SECRET` are configured, the server obtains and caches an access token automatically via OAuth 2.0 client credentials. There is no fallback to shared-volume URLs or direct PlantUML URLs.

---

## Tools, Prompts & Resources
- **Tools** are automatically registered through `tools/list`. They perform validation and optional auto-fixes, persist rendered diagrams through `ob-file`, and return structured metadata plus native MCP PNG `image` content up to the configured inline-size limit. SVG requests keep their public SVG URL and include a PNG preview for host compatibility.
- Diagram generation tools require `ob-file` and expose only the public `diagram_url` and `markdown_embed`; internal PlantUML URLs and storage metadata are not returned.
- `encode_plantuml` returns only the encoded payload and no longer exposes direct PlantUML render URLs.
- **Prompts** guide the model through PlantUML error handling and provide a ready-made capability landscape template.
- `archimate_macro_reference` is loaded from `documentation/archimate_macro_reference.md`, so the reference can evolve without code changes.
- For ArchiMate, the official PlantUML stdlib defines the macros (`Business_Service`, `Motivation_Principle`, `Grouping`, `Rel_Serving`, etc.), while fields such as `code`, `note`, `description`, `extra`, `raw`, `layout`, `format`, `legend_type`, and `use_local_stdlib` are extensions added by `mcp-plantuml`.
- When `EXPOSE_PROMPT_AS_TOOL=true`, every prompt is mirrored as a tool for MCP clients that do not consume prompts.
- **Resource templates** expose onboarding content (`resource://plantuml/server-guide`) so clients can self-discover usage instructions.

---

## Docker Image
The provided [Dockerfile](Dockerfile) builds the TypeScript sources and produces a minimal runtime image:
```bash
docker build -t plantuml-mcp-server .
docker run --rm -e MCP_TRANSPORT=http -p 8765:8765 plantuml-mcp-server
```
Override environment variables (`PLANTUML_SERVER_URL`, `MCP_API_KEY`, etc.) as needed.

---

## Testing & Tooling
- `npm run build` – compile TypeScript
- `npm start` – run using the default HTTP transport
- `npm run start:sse` / `npm run start:stdio` – convenience scripts
- `npm run test:business-scenario` – snapshot test that converts `test_files/generate_sequence_diagram/payload.json` into PlantUML and compares it to `expected.puml`
- `make test-mcp` – smoke-test commands through the `mcp` CLI

---

## Need Help?
- Verify connectivity with `curl http://<host>:<port>/healthz`
- Confirm auth headers match `MCP_API_KEY` (Bearer token) if enabled
- Use the MCP Inspector or Flowise node logs to trace JSON-RPC payloads

The server ships with everything required to operate over HTTP, SSE, and STDIO. Plug in the transport that matches your environment and start generating diagrams!
