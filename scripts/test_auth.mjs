import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const audience = 'https://mcp-servers.shared.mpn/plantuml/api/mcp';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

test('OIDC protects every MCP request and binds sessions to their subject', async (t) => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let issuer;
  const downstreamHeaders = [];
  let tokenRequest;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === '/token') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { tokenRequest = new URLSearchParams(body); res.end(JSON.stringify({ access_token: 'downstream-machine-token', expires_in: 300 })); });
      return;
    }
    if (req.url.startsWith('/api/files/')) {
      downstreamHeaders.push(req.headers.authorization);
      if (req.url.endsWith('/public-url')) return res.end(JSON.stringify({ download_url: 'https://example.test/diagram.png' }));
      req.resume();
      return res.end('{}');
    }
    if (req.url.startsWith('/txt/')) return res.end('ok');
    if (req.url.startsWith('/png/')) return res.end(Buffer.from('test-image'));
    res.writeHead(404).end();
  });
  const fixturePort = await listen(fixture);
  issuer = `http://127.0.0.1:${fixturePort}`;
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const child = spawn(process.execPath, ['dist/plantuml-mcp-server.js'], {
    env: { ...process.env, MCP_TRANSPORT: 'http', MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_AUTH_MODE: 'oidc',
      OIDC_ISSUER_URL: issuer, MCP_OIDC_ALLOW_INSECURE_LOOPBACK: 'true', OIDC_AUDIENCE: audience, MCP_RESOURCE_URL: audience,
      MCP_HTTP_ENABLE_JSON_RESPONSES: 'true', PLANTUML_SERVER_URL: issuer, OB_FILE_API_BASE_URL: issuer,
      OB_FILE_OIDC_TOKEN_ENDPOINT: `${issuer}/token`, OB_FILE_OIDC_CLIENT_ID: 'mcp-plantuml', OB_FILE_OIDC_CLIENT_SECRET: 'test-secret', LOG_LEVEL: 'debug' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); await close(fixture); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const token = async (overrides = {}, options = {}) => {
    const claims = { sub: 'human-a', client_id: 'mcp-dcs-plantuml', groups: ['users'], scope: 'plantuml:render', ...overrides };
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? audience).setJti('test-id').setExpirationTime(options.expires ?? '5m').sign(privateKey);
  };
  const valid = await token();
  const missingJti = await new SignJWT({ sub: 'human-a', client_id: 'mcp-dcs-plantuml', groups: ['users'], scope: 'plantuml:render' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience(audience).setExpirationTime('5m').sign(privateKey);
  const otherKeys = await generateKeyPair('RS256');
  const wrongSignature = await new SignJWT({ sub: 'human-a', client_id: 'mcp-dcs-plantuml', groups: ['users'], scope: 'plantuml:render' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience(audience).setJti('test-id').setExpirationTime('5m').sign(otherKeys.privateKey);
  const rpc = async (bearer, body, session) => fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(body),
  });
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/plantuml/api/mcp`);
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), { resource: audience, authorization_servers: [issuer], scopes_supported: ['plantuml:render'], bearer_methods_supported: ['header'] });
  for (const invalid of [undefined, 'not-a-jwt', missingJti, wrongSignature, await token({}, { expires: '-1s' }), await token({}, { issuer: 'https://wrong.test' }), await token({}, { audience: 'wrong' })]) {
    const response = await rpc(invalid, initialize);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
  }
  for (const claims of [{ client_id: 'wrong' }, { scope: 'other' }, { sub: '' }, { groups: [] }, { groups: 'users' }]) {
    assert.equal((await rpc(await token(claims), initialize)).status, 403);
  }
  const initialized = await rpc(valid, initialize);
  assert.equal(initialized.status, 200);
  const session = initialized.headers.get('mcp-session-id');
  assert.ok(session);
  assert.equal((await rpc(undefined, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).status, 401);
  assert.equal((await rpc(await token({ sub: 'human-b' }), { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).status, 403);
  const listed = await rpc(valid, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).result.tools.some((tool) => tool.name === 'generate_plantuml_diagram'));
  const rendered = await rpc(valid, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_plantuml_diagram', arguments: { plantuml_code: '@startuml\nA -> B\n@enduml', format: 'png' } } }, session);
  assert.equal(rendered.status, 200);
  const result = await rendered.json();
  assert.equal(result.result.structuredContent.success, true);
  assert.ok(downstreamHeaders.length >= 2);
  assert.ok(downstreamHeaders.every((header) => header === 'Bearer downstream-machine-token'));
  assert.equal(tokenRequest.get('client_id'), 'mcp-plantuml');
  assert.equal(tokenRequest.get('audience'), 'https://mcp-servers.shared.mpn/obfile/api/mcp');
  assert.equal(tokenRequest.get('scope'), 'obfile:write');
  assert.ok(!logs.includes(valid));
  assert.ok(!logs.includes('human-a'));
});

test('startup rejects incomplete OIDC and non-loopback local bypass', async () => {
  for (const env of [{ MCP_AUTH_MODE: 'oidc', OIDC_ISSUER_URL: '', OIDC_AUDIENCE: '', MCP_RESOURCE_URL: '' }, { MCP_AUTH_MODE: 'none', MCP_HOST: '0.0.0.0' }, { MCP_AUTH_MODE: 'oidc', MCP_OIDC_ALLOW_INSECURE_LOOPBACK: 'true', MCP_HOST: '0.0.0.0' }]) {
    const child = spawn(process.execPath, ['dist/plantuml-mcp-server.js'], { env: { ...process.env, MCP_TRANSPORT: 'http', ...env }, stdio: 'ignore' });
    assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 1);
  }
});
