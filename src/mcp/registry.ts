import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { ToolContext, ToolDef } from '@/core/contracts/tool';
import { AccountSelectionError, GuardrailError, ProviderError } from '@/core/errors';
import { createListAccountsTool } from './tools/list_accounts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<z.ZodObject<any>>;

/** Every enabled tool. Excluded tools are never listed here. */
export function getToolDefs(baseUrl: string): AnyToolDef[] {
  return [createListAccountsTool(baseUrl)];
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
          const result = await def.handler(args as never, ctx);
          done('ok');
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
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
