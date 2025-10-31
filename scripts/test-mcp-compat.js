#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SDK_PACKAGE_PATH = join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
const SERVER_ENTRY = join(__dirname, '..', 'dist', 'plantuml-mcp-server.js');
const REPORT_PATH = join(__dirname, '..', 'compatibility-report.md');

const summary = [];
const errors = [];

function pass(message) {
  console.log(`[PASS] ${message}`);
  summary.push(`- ✅ ${message}`);
}

function info(message) {
  console.log(`[INFO] ${message}`);
  summary.push(`- ℹ️ ${message}`);
}

function fail(message, error) {
  console.error(`[FAIL] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    errors.push(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  } else {
    errors.push(message);
  }
}

async function main() {
  let sdkVersion = 'unknown';
  try {
    const pkg = JSON.parse(await readFile(SDK_PACKAGE_PATH, 'utf8'));
    sdkVersion = pkg.version ?? sdkVersion;
    pass(`Detected SDK version ${sdkVersion}`);
  } catch (error) {
    fail('Unable to determine SDK version', error);
  }

  const client = new Client(
    {
      name: 'plantuml-mcp-compat-client',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
        completions: {},
        logging: {},
      },
    },
  );

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: 'stdio',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'debug',
      PLANTUML_SERVER_URL: process.env.PLANTUML_SERVER_URL ?? 'https://www.plantuml.com/plantuml',
    },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    pass('Connected to server via stdio transport');
  } catch (error) {
    fail('Failed to connect to PlantUML MCP server', error);
    await safeClose(client, transport);
    await writeReport(sdkVersion);
    process.exitCode = 1;
    return;
  }

  try {
    const listResult = await client.listTools({});
    const toolNames = listResult.tools.map((tool) => tool.name);
    pass(`tools/list returned ${JSON.stringify(toolNames)}`);
  } catch (error) {
    fail('tools/list request failed', error);
  }

  try {
    const callResult = await client.callTool({
      name: 'generate_plantuml_diagram',
      arguments: {
        plantuml_code: '@startuml\nAlice -> Bob: Hi\n@enduml',
        format: 'svg',
      },
    });

    const success =
      callResult?.structuredContent?.success === true ||
      callResult?.result?.structuredContent?.success === true;

    if (success) {
      pass('tools/call returned structuredContent.success === true');
    } else {
      fail('tools/call did not return success=true', callResult);
    }
  } catch (error) {
    fail('tools/call request failed', error);
  }

  await safeClose(client, transport);
  await writeReport(sdkVersion);

  if (errors.length > 0) {
    console.error('\nCompatibility issues detected:');
    for (const issue of errors) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`\n✅ PlantUML MCP Server is fully compatible with SDK v${sdkVersion}`);
  }
}

async function safeClose(client, transport) {
  try {
    await client.close();
  } catch {}
  try {
    await transport.close();
  } catch {}
}

async function writeReport(sdkVersion) {
  const reportLines = [
    '# PlantUML MCP – SDK v1.19.1 Compatibility Report',
    '',
    `- **SDK version**: ${sdkVersion}`,
    '- **Summary:**',
    ...summary,
    '',
    '- **Errors:**',
    ...(errors.length > 0 ? errors.map((err) => `  - ❌ ${err}`) : ['  - ✅ None']),
    '',
  ];

  await writeFile(REPORT_PATH, reportLines.join('\n'), 'utf8');
  info(`Compatibility report written to ${REPORT_PATH}`);
}

await main();
