import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const CLIENT = 'mcp-dcs-plantuml';
const SCOPE = 'plantuml:render';
const AUDIENCE = 'https://mcp-servers.shared.mpn/plantuml/api/mcp';
type Decision = { status: 200; principal: string } | { status: 401 | 403 };

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
  private readonly audience?: string;
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
    this.audience = env.OIDC_AUDIENCE;
    if (this.audience !== AUDIENCE) throw new Error('OIDC_AUDIENCE must be the canonical PlantUML audience');
    if (this.resource !== AUDIENCE) throw new Error('MCP_RESOURCE_URL must be the canonical PlantUML resource');
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
    if (!match) return { status: 401 };
    try {
      if (!this.jwks) {
        const discovery = await fetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!discovery.ok) return { status: 401 };
        const metadata = await discovery.json() as { issuer?: string; jwks_uri?: string };
        if (metadata.issuer !== this.issuer) return { status: 401 };
        const uri = checkedUrl(metadata.jwks_uri, 'jwks_uri', this.allowLoopbackHttp);
        if (uri.origin !== new URL(this.issuer!).origin) return { status: 401 };
        this.jwks = createRemoteJWKSet(uri, { timeoutDuration: 5000 });
      }
      const { payload } = await jwtVerify(match[1], this.jwks, {
        issuer: this.issuer, audience: this.audience, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'jti'],
      });
      const audiences = typeof payload.aud === 'string'
        ? [payload.aud]
        : Array.isArray(payload.aud) && payload.aud.every((audience) => typeof audience === 'string')
          ? payload.aud
          : [];
      if (typeof payload.jti !== 'string' || !payload.jti.trim() || !audiences.includes(this.audience!)) return { status: 401 };
      const client = payload.client_id ?? payload.azp;
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
      if (typeof payload.sub !== 'string' || !payload.sub.trim() || client !== CLIENT ||
          (payload.client_id !== undefined && payload.client_id !== CLIENT) || (payload.azp !== undefined && payload.azp !== CLIENT) ||
          !Array.isArray(payload.groups) || !payload.groups.every((group) => typeof group === 'string') ||
          !payload.groups.includes('users') || !scopes.includes(SCOPE)) return { status: 403 };
      return { status: 200, principal: createHash('sha256').update(JSON.stringify([payload.sub, CLIENT])).digest('hex') };
    } catch {
      return { status: 401 };
    }
  }

  reject(res: ServerResponse, status: 401 | 403): void {
    const metadata = `${new URL(this.resource!).origin}${this.metadataPath}`;
    const error = status === 401 ? 'invalid_token' : 'insufficient_scope';
    res.writeHead(status, { 'Content-Type': 'text/plain', 'WWW-Authenticate': `Bearer resource_metadata="${metadata}", error="${error}"` });
    res.end(status === 401 ? 'Unauthorized' : 'Forbidden');
  }
}
