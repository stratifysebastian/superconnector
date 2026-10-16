import type { ServerContext } from '@/server/context';
import { MCP_SCOPE, mcpResource } from './common';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** RFC 8414 */
export function authorizationServerMetadata(ctx: Pick<ServerContext, 'baseUrl'>): Response {
  const b = ctx.baseUrl;
  return json({
    issuer: b,
    authorization_endpoint: `${b}/authorize`,
    token_endpoint: `${b}/token`,
    registration_endpoint: `${b}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true, // RFC 9207
  });
}

/** RFC 9728 */
export function protectedResourceMetadata(ctx: Pick<ServerContext, 'baseUrl'>): Response {
  return json({
    resource: mcpResource(ctx.baseUrl),
    authorization_servers: [ctx.baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [MCP_SCOPE],
  });
}
