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
          // It may also return `mcpText`: the text block is then that string as it is (plain-text tools), not JSON.
          const { mcpImage, mcpText, ...json } = result as { mcpImage?: { data: string; mimeType: string }; mcpText?: string } & Record<string, unknown>;
          // Only png/jpeg, valid base64, at most 2,000,000 characters; anything else is dropped and the text result stays.
          const okImage = mcpImage && /^image\/(png|jpeg)$/.test(mcpImage.mimeType) && mcpImage.data.length <= 2_000_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(mcpImage.data);
          return {
            content: [
              { type: 'text', text: typeof mcpText === 'string' ? mcpText : JSON.stringify(json) },
              ...(okImage ? [{ type: 'image' as const, data: mcpImage.data, mimeType: mcpImage.mimeType }] : []),
            ],
            structuredContent: json,
          };
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
