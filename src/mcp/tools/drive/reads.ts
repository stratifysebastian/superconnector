import { getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import type { GFile, RecentOrder } from '@/core/contracts/drive';
import { resolveAccounts } from '@/core/accounts';
import { accountField, drive, driveTool, lookupOne, MAX_BYTES, pageToken, snippetArgs } from './common';
import { translateQuery } from './query';

const ms = (s: string | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const SNIPPET_NOTE = 'excludeContentSnippets and snippetVerbosity are accepted and ignored here: this tool returns no content snippets (use get_file_metadata).';

const searchInput = z.object({
  query: z.string().max(2000).optional().describe("Structured query: `term operator 'value'` joined with and/or/not and parentheses. Terms: title (contains, =, !=), fullText (contains), mimeType (contains, =, !=), modifiedTime/viewedByMeTime/createdTime (<=, <, =, !=, >, >= with RFC 3339), parentId (=, !=; 'root' is My Drive), owner (=, !=; 'me'), sharedWithMe and starred (= or != true/false). Escape quotes as \\'."),
  pageSize: z.number().int().min(1).max(100).optional().describe('Default 20, max 100.'),
  pageToken,
  ...snippetArgs,
  account: accountField,
});
export const searchFilesTool = driveTool({
  name: 'search_files',
  description:
    'Searches Drive files on every connected account (or the one in `account`) with a structured query, merged newest first by modifiedTime. A file visible to both accounts appears once, with `accounts` and `sources`. ' +
    'fullText searches cannot be sorted by Drive, so they are listed account by account in priority order instead. Queries outside the grammar are refused. Files in the bin are excluded. ' +
    SNIPPET_NOTE,
  input: searchInput,
  kind: 'read',
  async handler(input, ctx) {
    const { q, hasFullText } = translateQuery(input.query);
    // Account-by-account listing can't de-duplicate across pages, so a later account skips files owned by an
    // earlier selected account (that account already lists them). shortcut: a third party's file shared with
    // both accounts can still appear twice in fullText results; fix if Drive turns out to sort fullText.
    const selected = hasFullText ? resolveAccounts(input.account, await ctx.store.accounts.list()) : [];
    const r = await ctx.fanout.read<GFile>({
      selector: input.account,
      page: { pageSize: input.pageSize ?? 20, cursor: input.pageToken },
      fetch: async (account, token, pageSize) => {
        const p = await drive(ctx, account).searchFiles({ q, pageSize, ...(token ? { pageToken: token } : {}), orderByModified: !hasFullText });
        const earlier = new Set(selected.slice(0, selected.findIndex((a) => a.label === account.label)).map((a) => a.email.toLowerCase()));
        return { items: p.items.filter((f) => !earlier.has((f.owner ?? '').toLowerCase())), nextPageToken: p.nextPageToken };
      },
      dateOf: hasFullText ? () => 0 : (f) => ms(f.modifiedTime),
      dedupeKey: (f) => f.id,
      idOf: (f) => ({ id: f.id }),
    });
    return { files: r.items, ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}), accountErrors: r.accountErrors };
  },
});

const recency = (f: GFile) => Math.max(ms(f.modifiedTime), ms(f.viewedByMeTime), ms(f.modifiedByMeTime), ms(f.sharedWithMeTime), ms(f.createdTime));
const recentDate: Record<RecentOrder, (f: GFile) => number> = {
  recency,
  lastModified: (f) => ms(f.modifiedTime),
  lastModifiedByMe: (f) => ms(f.modifiedByMeTime),
};
const recentInput = z.object({
  orderBy: z.string().optional().describe('recency (default), lastModified or lastModifiedByMe. Other values fall back to recency.'),
  pageSize: z.number().int().min(1).max(100).optional().describe('Default 10.'),
  pageToken,
  ...snippetArgs,
  account: accountField,
});
export const listRecentTool = driveTool({
  name: 'list_recent_files',
  description:
    'Lists recently used files on every connected account (or the one in `account`), merged on the same time Drive sorted by. A file visible to both accounts appears once, with `accounts` and `sources`. ' + SNIPPET_NOTE,
  input: recentInput,
  kind: 'read',
  async handler(input, ctx) {
    const orderBy: RecentOrder = input.orderBy === 'lastModified' || input.orderBy === 'lastModifiedByMe' ? input.orderBy : 'recency';
    const r = await ctx.fanout.read<GFile>({
      selector: input.account,
      page: { pageSize: input.pageSize ?? 10, cursor: input.pageToken },
      fetch: async (account, token, pageSize) => {
        const p = await drive(ctx, account).listRecent({ orderBy, pageSize, ...(token ? { pageToken: token } : {}) });
        return { items: p.items, nextPageToken: p.nextPageToken };
      },
      dateOf: recentDate[orderBy],
      dedupeKey: (f) => f.id,
      idOf: (f) => ({ id: f.id }),
    });
    const files = r.items.map(({ modifiedByMeTime: _a, sharedWithMeTime: _b, ...rest }) => rest);
    return { files, ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}), accountErrors: r.accountErrors };
  },
});

const SNIPPET_CHARS = { BRIEF: 1000, MEDIUM: 2500, DETAILED: 5000, MAX_ALLOWED: 20000 } as const;
export const snippetChars = (exclude: boolean | undefined, v: string | undefined): number | undefined =>
  exclude ? undefined : (SNIPPET_CHARS[v as keyof typeof SNIPPET_CHARS] ?? 5000);

export const getMetadataTool = driveTool({
  name: 'get_file_metadata',
  description:
    'Gets one file\'s metadata, trying accounts in priority order unless `account` is given. For Google-native files, contentSnippet is the start of the text, cut to snippetVerbosity (BRIEF 1000, MEDIUM 2500, DETAILED 5000, MAX_ALLOWED 20000 characters); excludeContentSnippets omits it.',
  input: z.object({ fileId: z.string(), ...snippetArgs, account: accountField }),
  kind: 'lookup',
  handler: (input, ctx) =>
    lookupOne(ctx, input.account, (a) => {
      const chars = snippetChars(input.excludeContentSnippets, input.snippetVerbosity);
      return drive(ctx, a).getFile({ fileId: input.fileId, ...(chars ? { snippetChars: chars } : {}) });
    }),
});

export const getPermissionsTool = driveTool({
  name: 'get_file_permissions',
  description: 'Lists who a file is shared with (read only), trying accounts in priority order unless `account` is given.',
  input: z.object({ fileId: z.string(), account: accountField }),
  kind: 'lookup',
  handler: (input, ctx) =>
    lookupOne(ctx, input.account, async (a) => {
      const permissions = await drive(ctx, a).getPermissions({ fileId: input.fileId });
      return permissions ? { permissions } : null;
    }),
});

const NATIVE = 'application/vnd.google-apps.';
const PDF_MAX_BYTES = 1_000_000;
const PDF_MAX_PAGES = 100;
const PDF_MAX_CHARS = 200_000;
// isEvalSupported is a real pdf.js option missing from unpdf's types; a variable skips the excess-property check.
const PDF_OPTIONS = { verbosity: 0, isEvalSupported: false, disableFontFace: true };
const TEXTUAL = (m: string) => m.startsWith('text/') || m === 'application/json';

export const readFileTool = driveTool({
  name: 'read_file_content',
  description:
    'Reads a file as text, trying accounts in priority order unless `account` is given. Google Docs/Slides are exported as text, Sheets as CSV, PDFs have their text extracted, PNG and JPEG are returned as image content. ' +
    'Office and other types return a message pointing to download_file_content. Files over 1.5 MB are refused (PDFs over 1 MB or 100 pages are not extracted). includeComments is accepted and ignored (comments are not returned).',
  input: z.object({ fileId: z.string(), includeComments: z.boolean().optional(), account: accountField }),
  kind: 'lookup',
  handler: (input, ctx) =>
    lookupOne(ctx, input.account, async (a) => {
      const d = drive(ctx, a);
      const meta = await d.getFile({ fileId: input.fileId });
      if (!meta) return null;
      const mime = meta.mimeType;
      const isNative = mime.startsWith(NATIVE);
      const isImage = /^image\/(png|jpe?g)$/.test(mime);
      const out = (fileContent: string, extra: object = {}) => ({ fileContent, title: meta.title, ...(meta.viewUrl ? { viewUrl: meta.viewUrl } : {}), ...extra });
      if (!isNative && mime !== 'application/pdf' && !isImage && !TEXTUAL(mime)) {
        return out(`This file type (${mime}) cannot be read as text. Use download_file_content to fetch its bytes.`);
      }
      const got = await d.download({
        fileId: input.fileId,
        maxBytes: MAX_BYTES,
        ...(isNative ? { exportMimeType: mime === `${NATIVE}spreadsheet` ? 'text/csv' : 'text/plain' } : {}),
      });
      if (!got) return null;
      if (isImage) return out(`Image file (${mime}); shown as image content.`, { mcpImage: { data: Buffer.from(got.bytes).toString('base64'), mimeType: mime === 'image/png' ? 'image/png' : 'image/jpeg' } });
      if (mime === 'application/pdf') {
        if (got.bytes.length > PDF_MAX_BYTES) return out('This PDF is larger than 1 MB, which is too large to extract text from here. Use download_file_content to fetch its bytes.');
        try {
          // shortcut: pdf.js runs in-process, so a decompression bomb under 1 MB can still use a lot of memory; upgrade is a worker with a hard timeout.
          const pdf = await getDocumentProxy(new Uint8Array(got.bytes), PDF_OPTIONS);
          if (pdf.numPages > PDF_MAX_PAGES) return out(`This PDF has ${pdf.numPages} pages, more than the ${PDF_MAX_PAGES} this server reads. Use download_file_content to fetch its bytes.`);
          let text = '';
          for (let i = 1; i <= pdf.numPages && text.length < PDF_MAX_CHARS; i++) {
            const page = await pdf.getPage(i);
            text += (await page.getTextContent()).items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('') + '\n';
          }
          return out(text.slice(0, PDF_MAX_CHARS));
        } catch {
          return out('The PDF text could not be extracted. Use download_file_content to fetch its bytes.');
        }
      }
      return out(new TextDecoder().decode(got.bytes));
    }),
});

export const downloadFileTool = driveTool({
  name: 'download_file_content',
  description:
    'Downloads a file as base64 ({content, id, mimeType, title}), trying accounts in priority order unless `account` is given. Google-native files are exported (exportMimeType, default a text type). Files over 1.5 MB are refused.',
  input: z.object({ fileId: z.string(), exportMimeType: z.string().optional(), revisionId: z.string().optional(), account: accountField }),
  kind: 'lookup',
  handler: (input, ctx) =>
    lookupOne(ctx, input.account, async (a) => {
      const got = await drive(ctx, a).download({
        fileId: input.fileId,
        maxBytes: MAX_BYTES,
        ...(input.exportMimeType ? { exportMimeType: input.exportMimeType } : {}),
        ...(input.revisionId ? { revisionId: input.revisionId } : {}),
      });
      return got ? { content: Buffer.from(got.bytes).toString('base64'), id: input.fileId, mimeType: got.mimeType, title: got.title } : null;
    }),
});
