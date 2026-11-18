import { z } from 'zod';
import type { Account } from '@/core/contracts/account';
import type { GAttachmentMeta, GMessage } from '@/core/contracts/gmail';
import type { ToolContext } from '@/core/contracts/tool';
import { GuardrailError } from '@/core/errors';
import { audited as driveAudited, drive, MAX_GMAIL_ATTACHMENT_BYTES, refuseSharedFolder } from '../drive/common';
import { extractPdfText } from '../pdf-text';
import { accountField, gmailTool, tag } from './common';

/** Largest file returned inline: 3 MB raw is 4 MB of base64, which keeps the response under Vercel's ~4.5 MB. */
export const MAX_INLINE_BYTES = 3_000_000;
export const ATTACHMENTS_FOLDER = 'Superconnector attachments';
const TOOL = 'download_gmail_attachment';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_QUERY = `name = '${ATTACHMENTS_FOLDER}' and 'root' in parents and mimeType = '${FOLDER_MIME}'`;

const input = z.object({
  messageId: z.string(),
  attachmentId: z.string().optional().describe('Gmail attachment id. Ids can change between calls, so attachmentIndex is more reliable.'),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  attachmentIndex: z.number().int().min(0).optional().describe('Position in the email\'s attachment list (0 is the first).'),
  saveToDrive: z.boolean().optional().describe('Save the file into the folder "Superconnector attachments" in My Drive of the same account instead of returning it. Works up to 12 MB. Default false.'),
  account: accountField,
});

const MB = (n: number) => `${n / 1_000_000} MB`;
const clean = (s: string) => s.replace(/[\u0000-\u001f"]/g, '');
const plainMime = (m: string | undefined) => (m && /^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*$/.test(m) ? m : 'application/octet-stream');

/** The attachment a call means: index, then id, then filename (+ mimeType), then "the only one". Null for none or several. */
function pick(list: GAttachmentMeta[], i: z.infer<typeof input>): number | null {
  const only = (idx: number[]) => (idx.length === 1 ? idx[0]! : null);
  const where = (f: (a: GAttachmentMeta) => boolean) => list.flatMap((a, n) => (f(a) ? [n] : []));
  const found =
    (i.attachmentIndex !== undefined && list[i.attachmentIndex] ? i.attachmentIndex : null) ??
    (i.attachmentId ? only(where((a) => a.id === i.attachmentId)) : null) ??
    (i.filename ? only(where((a) => a.filename === i.filename && (!i.mimeType || a.mimeType === i.mimeType))) : null) ??
    (!i.filename && i.mimeType ? only(where((a) => a.mimeType === i.mimeType)) : null);
  return found ?? (list.length === 1 ? 0 : null);
}

function numbered(list: GAttachmentMeta[]): string {
  if (!list.length) return 'This email has no attachments.';
  const rows = list.map((a, n) => `${n}. "${clean(a.filename ?? '') || '(no name)'}" (${plainMime(a.mimeType)}, ${a.size ?? 'unknown'} bytes)`);
  return `Could not tell which attachment you mean. This email has ${list.length}:\n${rows.join('\n')}\nCall download_gmail_attachment again with attachmentIndex set to the number you want.`;
}

const tooBig = () => new GuardrailError('attachment_too_large', `This attachment is larger than ${MB(MAX_GMAIL_ATTACHMENT_BYTES)}, which this server cannot download.`);

/** Finds or creates the folder, refuses it if it is shared, uploads. Writes are audited with ids only. */
async function saveToDrive(ctx: ToolContext, account: Account, messageId: string, name: string, mimeType: string, bytes: Uint8Array) {
  const d = drive(ctx, account);
  let folder = (await d.searchFiles({ q: FOLDER_QUERY, pageSize: 1, orderByModified: false })).items[0];
  folder ??= await driveAudited(ctx, TOOL, account, messageId, (f) => f.id, () => d.createFile({ title: ATTACHMENTS_FOLDER, mimeType: FOLDER_MIME, convert: false }));
  await refuseSharedFolder(ctx, TOOL, account, folder.id, messageId);
  return driveAudited(ctx, TOOL, account, messageId, (f) => f.id, () =>
    d.createFile({ title: name, parentId: folder.id, content: { bytes, contentType: mimeType }, convert: false }),
  );
}

export const downloadGmailAttachmentTool = gmailTool({
  name: 'download_gmail_attachment',
  description:
    'Downloads one attachment of an email, trying accounts in priority order unless `account` is given. Identify it by attachmentIndex (best), attachmentId, or filename; if that is not clear the reply lists the email\'s attachments with numbers. ' +
    'Files up to 3 MB come back as content (PDFs also as extracted text, images as images); larger PDFs come back as extracted text only. Files over 12 MB are refused. ' +
    `saveToDrive: true saves the file (up to 12 MB) into the folder "${ATTACHMENTS_FOLDER}" in My Drive of the same account and returns the Drive file; it is refused if that folder is shared with other people. Nothing is ever sent or shared.`,
  input,
  kind: 'write',
  async handler(i, ctx) {
    const gmail = (a: Account) => ctx.adapters.gmail(ctx.adapterContext(a));
    const { item, accountErrors } = await ctx.fanout.lookup(i.account, (a) => gmail(a).getMessage({ messageId: i.messageId, format: 'FULL_CONTENT' }));
    if (!item) return { mcpText: `No message with that id was found on ${i.account ? 'the selected' : 'any connected'} account.`, accountErrors };
    const account = (await ctx.store.accounts.list()).find((a) => a.label === item.account);
    if (!account) throw new GuardrailError('account_not_found', 'The account that holds this message is no longer connected.');

    const list = (item as GMessage).attachments ?? [];
    const index = pick(list, i);
    if (index === null) return { mcpText: numbered(list) };
    const att = list[index]!;
    const mimeType = plainMime(att.mimeType);
    const isPdf = mimeType === 'application/pdf';
    if ((att.size ?? 0) > MAX_GMAIL_ATTACHMENT_BYTES) throw tooBig();
    const tooBigInline = (n: number) =>
      `This attachment (${n} bytes) is too big to return directly (limit ${MB(MAX_INLINE_BYTES)}). Call again with saveToDrive: true to put it in your Drive, in the folder "${ATTACHMENTS_FOLDER}".`;
    if (!i.saveToDrive && !isPdf && (att.size ?? 0) > MAX_INLINE_BYTES) return { mcpText: tooBigInline(att.size!) };

    const bytes = await gmail(account).getAttachment({ messageId: i.messageId, ...(att.id ? { attachmentId: att.id } : {}), index });
    if (!bytes) return { mcpText: 'The attachment could not be fetched; it may have been removed from the email.' };
    if (bytes.length > MAX_GMAIL_ATTACHMENT_BYTES) throw tooBig();

    const name = att.filename || `attachment-${index}`;
    const line = `Downloaded from Gmail by Superconnector: "${clean(name)}" (${mimeType}, ${bytes.length} bytes).`;
    const meta = tag({ attachment: { index, filename: name, mimeType, size: bytes.length } }, account);

    if (i.saveToDrive) {
      const f = await saveToDrive(ctx, account, i.messageId, name, mimeType, bytes);
      return { ...meta, message: `${line} Saved to Google Drive in "${ATTACHMENTS_FOLDER}".`, file: { title: f.title, id: f.id, ...(f.viewUrl ? { viewUrl: f.viewUrl } : {}) } };
    }
    const inline = bytes.length <= MAX_INLINE_BYTES;
    if (!inline && !isPdf) return { ...meta, mcpText: tooBigInline(bytes.length) };

    const blob = inline ? Buffer.from(bytes).toString('base64') : '';
    if (!isPdf) {
      const content = /^image\/(png|jpeg|gif|webp)$/.test(mimeType) ? { mcpImage: { data: blob, mimeType } } : { mcpResource: { uri: `gmail-attachment://${i.messageId}/${index}`, mimeType, blob } };
      return { ...meta, mcpText: line, ...content };
    }
    const pdf = await extractPdfText(bytes);
    const text = pdf.ok ? `\n\nExtracted text:\n${pdf.text}` : pdf.reason === 'too_many_pages' ? `\n\nThe text was not extracted: the PDF has ${pdf.pages} pages.` : '\n\nThe text could not be extracted.';
    return {
      ...meta,
      mcpText: inline ? line + text : `${line}${text}\n\nThe file itself is too big to return (over ${MB(MAX_INLINE_BYTES)}). Call again with saveToDrive: true to save it to your Drive.`,
      ...(inline ? { mcpResource: { uri: `gmail-attachment://${i.messageId}/${index}`, mimeType, blob } } : {}),
    };
  },
});
