import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { ToolContext, ToolDef } from '@/core/contracts/tool';
import { scopeToolContext } from '@/core/scope';
import { AccountSelectionError, GuardrailError, ProviderError } from '@/core/errors';
import { calendarTools } from './tools/calendar';
import { driveTools } from './tools/drive';
import { gmailTools } from './tools/gmail';
import { createListAccountsTool } from './tools/list_accounts';
import { quickbooksTools } from './tools/quickbooks';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<z.ZodObject<any>>;

/** Every enabled tool. Excluded tools are never listed here. */
export function getToolDefs(baseUrl: string): AnyToolDef[] {
  return [createListAccountsTool(baseUrl), ...calendarTools(), ...gmailTools(), ...driveTools(), ...quickbooksTools()];
}

/** 3 MB of raw bytes is 4,000,000 base64 characters; text, structuredContent and this block must fit Vercel's ~4.5 MB response. */
export const MAX_BLOCK_BASE64_CHARS = 4_000_000;
/** Largest JSON-RPC result we send; Vercel's limit is about 4.5 MB. */
export const MAX_RESPONSE_BYTES = 4_300_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const validImage = (i: { data: string; mimeType: string }): boolean =>
  /^image\/(png|jpeg|gif|webp)$/.test(i.mimeType) && i.data.length > 0 && i.data.length <= MAX_BLOCK_BASE64_CHARS && BASE64.test(i.data);
const validResource = (r: { uri: string; mimeType: string; blob: string }): boolean =>
  typeof r.uri === 'string' &&
  /^gmail-attachment:\/\/[^\s/]+\/\d+$/.test(r.uri) &&
  typeof r.mimeType === 'string' &&
  /^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*$/.test(r.mimeType) &&
  typeof r.blob === 'string' &&
  r.blob.length <= MAX_BLOCK_BASE64_CHARS &&
  BASE64.test(r.blob);

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface BuildServerOptions {
  defs?: AnyToolDef[];
  /** Verified bearer subject, for logs only. */
  subject?: string;
  baseUrl: string;
}

export function buildServer(ctx: ToolContext, opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: 'multi-account-google', version: '0.1.0' });
  for (const def of opts.defs ?? getToolDefs(opts.baseUrl)) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.input },
      async (args: unknown): Promise<CallToolResult> => {
        const started = Date.now();
        const base = { tool: def.name, ...(opts.subject ? { subject: opts.subject } : {}) };
        const done = (outcome: string, level: 'info' | 'warn' | 'error' = 'info', extra: object = {}) =>
          ctx.log[level]({ ...base, ...extra, durationMs: Date.now() - started, outcome, msg: 'tool call' });
        try {
          // Provider scoping lives here, once: the handler never sees another provider's accounts.
          const provider = def.provider ?? 'google';
          const result = await def.handler(args as never, provider === 'any' ? ctx : scopeToolContext(ctx, provider));
          done('ok');
          // A handler may return `mcpImage` ({data: base64, mimeType}); it becomes an image block, not JSON text.
          // It may return `mcpResource` ({uri, mimeType, blob: base64}); it becomes an embedded resource block.
          // It may also return `mcpText`: the text block is then that string as it is (plain-text tools), not JSON.
          // None of the three is copied into structuredContent, so binary content is never sent twice.
          const { mcpImage, mcpResource, mcpText, ...json } = result as {
            mcpImage?: { data: string; mimeType: string };
            mcpResource?: { uri: string; mimeType: string; blob: string };
            mcpText?: string;
          } & Record<string, unknown>;
          // Anything invalid is dropped and the text result stays.
          const okImage = mcpImage && validImage(mcpImage);
          const okResource = mcpResource && validResource(mcpResource);
          const built: CallToolResult = {
            content: [
              { type: 'text', text: typeof mcpText === 'string' ? mcpText : JSON.stringify(json) },
              ...(okImage ? [{ type: 'image' as const, data: mcpImage.data, mimeType: mcpImage.mimeType }] : []),
              ...(okResource ? [{ type: 'resource' as const, resource: { uri: mcpResource.uri, mimeType: mcpResource.mimeType, blob: mcpResource.blob } }] : []),
            ],
            structuredContent: json,
          };
          // The real guarantee for Vercel's ~4.5 MB response: whatever the text, names and blobs add up to.
          if (Buffer.byteLength(JSON.stringify(built)) > MAX_RESPONSE_BYTES) {
            return {
              ...built,
              content: [...built.content.filter((c) => c.type === 'text'), { type: 'text', text: 'The file was too large to return here. Use saveToDrive (where the tool has it) or download_file_content to get it.' }],
            };
          }
          return built;
        } catch (e) {
          if (e instanceof AccountSelectionError || e instanceof GuardrailError) {
            done('rejected', 'warn');
            return errorResult(e.message);
          }
          if (e instanceof ProviderError) {
            done('error', 'warn', { kind: e.kind });
            return errorResult(e.message);
          }
          done('error', 'error', { kind: e instanceof Error ? e.name : typeof e });
          return errorResult('Internal error');
        }
      },
    );
  }
  return server;
}
