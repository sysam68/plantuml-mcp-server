import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const CLIENT = 'mcp-dcs-plantuml';
const SCOPE = 'plantuml:render';
const AUDIENCES = [
  'https://mcp-servers.fmpn.fr/plantuml/api/mcp',
  'https://mcp-servers.shared.mpn/plantuml/api/mcp',
] as const;
type Decision = { status: 200; principal: string } | { status: 401 | 403 };

function denied(status: 401 | 403, reason: string): Decision {
  console.warn(JSON.stringify({ event: 'oidc_authorization_denied', status, reason }));
  return { status };
}

function checkedUrl(value: string | undefined, label: string, allowLoopbackHttp: boolean): URL {
  if (!value) throw new Error(`${label} is required`);
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url;
}

export class ResourceAuthorization {
  private readonly issuer?: string;
  private readonly audiences?: string[];
  private readonly resource?: string;
  private readonly metadataPath?: string;
  private readonly allowLoopbackHttp: boolean;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly mode: string, host: string, transport: string, env: NodeJS.ProcessEnv = process.env) {
    this.allowLoopbackHttp = env.MCP_OIDC_ALLOW_INSECURE_LOOPBACK === 'true';
    if (this.allowLoopbackHttp && transport !== 'stdio' && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw new Error('MCP_OIDC_ALLOW_INSECURE_LOOPBACK requires a loopback bind');
    }
    if (mode === 'none') {
      if (transport !== 'stdio' && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
        throw new Error('MCP_AUTH_MODE=none requires a loopback bind');
      }
      return;
    }
    if (mode !== 'oidc' || transport === 'stdio') throw new Error('HTTP and SSE require MCP_AUTH_MODE=oidc; stdio requires explicit none');
    this.issuer = checkedUrl(env.OIDC_ISSUER_URL, 'OIDC_ISSUER_URL', this.allowLoopbackHttp).toString().replace(/\/$/, '');
    this.resource = checkedUrl(env.MCP_RESOURCE_URL, 'MCP_RESOURCE_URL', this.allowLoopbackHttp).toString().replace(/\/$/, '');
    this.audiences = (env.OIDC_AUDIENCES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    if (this.audiences.length !== AUDIENCES.length || !AUDIENCES.every((value) => this.audiences!.includes(value))) {
      throw new Error('OIDC_AUDIENCES must contain the public and internal PlantUML audiences');
    }
    if (!AUDIENCES.includes(this.resource as typeof AUDIENCES[number])) throw new Error('MCP_RESOURCE_URL must be a PlantUML resource');
    this.metadataPath = `/.well-known/oauth-protected-resource${new URL(this.resource).pathname.replace(/\/$/, '')}`;
  }

  metadata(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (this.mode !== 'oidc' || req.method !== 'GET' || pathname !== this.metadataPath) return false;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ resource: this.resource, authorization_servers: [this.issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] }));
    return true;
  }

  async authorize(req: IncomingMessage): Promise<Decision> {
    if (this.mode === 'none') return { status: 200, principal: 'local' };
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(req.headers.authorization ?? '');
    if (!match) return denied(401, 'missing_bearer_token');
    try {
      if (!this.jwks) {
        const discovery = await fetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!discovery.ok) return denied(401, 'discovery_unavailable');
        const metadata = await discovery.json() as { issuer?: string; jwks_uri?: string };
        if (metadata.issuer !== this.issuer) return denied(401, 'discovery_issuer_mismatch');
        const uri = checkedUrl(metadata.jwks_uri, 'jwks_uri', this.allowLoopbackHttp);
        if (uri.origin !== new URL(this.issuer!).origin) return denied(401, 'jwks_origin_mismatch');
        this.jwks = createRemoteJWKSet(uri, { timeoutDuration: 5000 });
      }
      const { payload } = await jwtVerify(match[1], this.jwks, {
        issuer: this.issuer, audience: this.audiences, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'jti'],
      });
      const audiences = typeof payload.aud === 'string'
        ? [payload.aud]
        : Array.isArray(payload.aud) && payload.aud.every((audience) => typeof audience === 'string')
          ? payload.aud
          : [];
      if (typeof payload.jti !== 'string' || !payload.jti.trim()) return denied(401, 'missing_token_id');
      if (!audiences.some((audience) => this.audiences!.includes(audience))) return denied(401, 'audience_mismatch');
      const client = payload.client_id ?? payload.azp;
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
      if (typeof payload.sub !== 'string' || !payload.sub.trim()) return denied(403, 'missing_subject');
      if (client !== CLIENT || (payload.client_id !== undefined && payload.client_id !== CLIENT) ||
          (payload.azp !== undefined && payload.azp !== CLIENT)) return denied(403, 'client_mismatch');
      if (!scopes.includes(SCOPE)) return denied(403, 'required_scope_missing');
      return { status: 200, principal: createHash('sha256').update(JSON.stringify([payload.sub, CLIENT])).digest('hex') };
    } catch {
      return denied(401, 'token_verification_failed');
    }
  }

  reject(res: ServerResponse, status: 401 | 403): void {
    const metadata = `${new URL(this.resource!).origin}${this.metadataPath}`;
    const error = status === 401 ? 'invalid_token' : 'insufficient_scope';
    res.writeHead(status, { 'Content-Type': 'text/plain', 'WWW-Authenticate': `Bearer resource_metadata="${metadata}", error="${error}"` });
    res.end(status === 401 ? 'Unauthorized' : 'Forbidden');
  }
}
