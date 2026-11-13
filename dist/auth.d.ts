import type { IncomingMessage, ServerResponse } from 'node:http';
type Decision = {
    status: 200;
    principal: string;
} | {
    status: 401 | 403;
};
export declare class ResourceAuthorization {
    private readonly mode;
    private readonly issuer?;
    private readonly audience?;
    private readonly resource?;
    private readonly metadataPath?;
    private readonly allowLoopbackHttp;
    private jwks?;
    constructor(mode: string, host: string, transport: string, env?: NodeJS.ProcessEnv);
    metadata(req: IncomingMessage, res: ServerResponse, pathname: string): boolean;
    authorize(req: IncomingMessage): Promise<Decision>;
    reject(res: ServerResponse, status: 401 | 403): void;
}
export {};
//# sourceMappingURL=auth.d.ts.map