import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { verifyBearer, verifyBearerWithContext } from '@/oauth/bearer';
import { getServerContext, type ServerContext } from '@/server/context';
import { buildServer, type AnyToolDef } from './registry';

export interface McpDeps {
  ctx?: ServerContext;
  verify?: typeof verifyBearer;
  /** Test injection point; defaults to the enabled tool registry. */
  defs?: AnyToolDef[];
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function methodNotAllowed(): Response {
  return json(405, { error: 'method_not_allowed', error_description: 'This MCP endpoint is stateless: use POST.' }, { Allow: 'POST' });
}

export async function handleMcpRequest(req: Request, deps: McpDeps = {}): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  const ctx = deps.ctx ?? (await getServerContext());
  const identity = await (deps.verify ?? ((r: Request) => verifyBearerWithContext(ctx, r)))(req);
  if (!identity) {
    return json(
      401,
      { error: 'unauthorized', error_description: 'A valid bearer token is required.' },
      { 'WWW-Authenticate': `Bearer resource_metadata="${ctx.baseUrl}/.well-known/oauth-protected-resource"` },
    );
  }
  const server = buildServer(
    { store: ctx.store, fanout: ctx.fanout, adapters: ctx.adapters, log: ctx.log },
    { baseUrl: ctx.baseUrl, subject: identity.subject, ...(deps.defs ? { defs: deps.defs } : {}) },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close().catch(() => undefined);
  }
}
