#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.PLANTUML_MCP_SKIP_AUTO_START = 'true';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_PATH = path.join(ROOT_DIR, 'dist', 'plantuml-mcp-server.js');
const FIXTURE_DIR = path.join(ROOT_DIR, 'test_files', 'generate_sequence_diagram');
const PAYLOAD_PATH = path.join(FIXTURE_DIR, 'payload.json');
const EXPECTED_PATH = path.join(FIXTURE_DIR, 'expected.puml');

function normalize(text) {
  return text.replace(/\r\n/g, '\n').trim();
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const shouldUpdate = process.argv.includes('--update');

  let moduleExports;
  try {
    moduleExports = await import(pathToFileURL(DIST_PATH));
  } catch (error) {
    console.error('Failed to load dist/plantuml-mcp-server.js. Run `npm run build` first.');
    console.error(error);
    process.exitCode = 1;
    return;
  }

  const { PlantUMLMCPServer } = moduleExports;
  if (!PlantUMLMCPServer) {
    console.error('PlantUMLMCPServer export not found. Ensure the build artefact is up to date.');
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(await fs.readFile(PAYLOAD_PATH, 'utf8'));
  const server = new PlantUMLMCPServer();
  const { plantumlCode, format } = server.buildBusinessScenarioFromPayload(payload);
  await server.close();

  if (shouldUpdate || !(await fileExists(EXPECTED_PATH))) {
    await fs.writeFile(EXPECTED_PATH, `${plantumlCode.trim()}\n`, 'utf8');
    console.log(`Updated ${path.relative(ROOT_DIR, EXPECTED_PATH)} with latest PlantUML output.`);
    return;
  }

  const expected = await fs.readFile(EXPECTED_PATH, 'utf8');
  if (normalize(expected) !== normalize(plantumlCode)) {
    console.error('Business scenario PlantUML output no longer matches the fixture.');
    console.error(`Expected fixture: ${EXPECTED_PATH}`);
    console.error('Use `node scripts/test_business_scenario_fixture.mjs --update` after intentional changes.');
    process.exitCode = 1;
    return;
  }

  console.log(`Business scenario fixture verified (format=${format}).`);
}

await main();
