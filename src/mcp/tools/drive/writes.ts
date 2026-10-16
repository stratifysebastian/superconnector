import { z } from 'zod';
import type { GFile } from '@/core/contracts/drive';
import { GuardrailError } from '@/core/errors';
import { accountField, audited, drive, driveTool, MAX_BYTES, refuseSharedFolder, tag, writeAccount } from './common';

const idOf = (f: GFile) => f.id;
const invalid = (m: string) => new GuardrailError('invalid_arguments', m);

const createInput = z.object({
  title: z.string(),
  parentId: z.string().optional().describe("Destination folder id. Omit for My Drive. Folders shared with other people are refused."),
  textContent: z.string().optional(),
  base64Content: z.string().optional(),
  content: z.string().optional().describe('Deprecated alias of base64Content.'),
  contentMimeType: z.string().optional().describe('Required with base64Content. Defaults to text/plain for textContent.'),
  mimeType: z.string().optional().describe('Deprecated; treated as contentMimeType. With no content, a Google type (document, spreadsheet, presentation, folder) creates it empty.'),
  disableConversionToGoogleType: z.boolean().optional(),
  account: accountField,
});
export const createFileTool = driveTool({
  name: 'create_file',
  description:
    'Creates a file on exactly one account (`account` is required). Give textContent or base64Content (not both), max 3 MB decoded. Uploads convert to the matching Google type unless disableConversionToGoogleType. ' +
    'Refused when the destination folder is shared with other people. Never shares anything.',
  input: createInput,
  kind: 'write',
  async handler(input, ctx) {
    const b64 = input.base64Content ?? input.content;
    if (input.textContent !== undefined && b64 !== undefined) throw invalid('Set either textContent or base64Content, not both.');
    const contentType = input.contentMimeType ?? input.mimeType;
    let bytes: Uint8Array | undefined;
    if (b64 !== undefined) {
      if (!contentType) throw invalid('contentMimeType is required when base64Content is given.');
      bytes = Buffer.from(b64, 'base64');
    } else if (input.textContent !== undefined) {
      bytes = new TextEncoder().encode(input.textContent);
    }
    if (bytes && bytes.length > MAX_BYTES) throw invalid('Content is larger than 3 MB, which this server can upload.');
    const account = await writeAccount(ctx, input.account, async () => null);
    await refuseSharedFolder(ctx, 'create_file', account, input.parentId, undefined);
    const file = await audited(ctx, 'create_file', account, undefined, idOf, () =>
      drive(ctx, account).createFile({
        title: input.title,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(bytes ? { content: { bytes, contentType: contentType ?? 'text/plain' } } : contentType ? { mimeType: contentType } : {}),
        convert: !input.disableConversionToGoogleType,
      }),
    );
    return tag(file, account);
  },
});

export const copyFileTool = driveTool({
  name: 'copy_file',
  description:
    'Copies a file on one account (defaults to the account that can see it). Without parentId the copy sits next to the original. Refused when the destination folder (or the original\'s folder) is shared with other people.',
  input: z.object({ fileId: z.string(), parentId: z.string().optional(), title: z.string().optional(), account: accountField }),
  kind: 'write',
  async handler(input, ctx) {
    const find = (a: Parameters<typeof drive>[1]) => drive(ctx, a).getFile({ fileId: input.fileId });
    const account = await writeAccount(ctx, input.account, find);
    const original = await find(account);
    if (!original) throw new GuardrailError('not_found', 'No file with that id was found on that account.');
    await refuseSharedFolder(ctx, 'copy_file', account, input.parentId ?? original.parentId, input.fileId);
    const file = await audited(ctx, 'copy_file', account, input.fileId, idOf, () =>
      drive(ctx, account).copyFile({
        fileId: input.fileId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
      }),
    );
    return tag(file, account);
  },
});

export const updateFileTool = driveTool({
  name: 'update_file',
  description:
    'Renames, describes or moves a file (title, description, parentId only) on one account (defaults to the account that can see it). Moving into a folder shared with other people is refused; renaming a file already in one is allowed.',
  input: z.object({ fileId: z.string(), title: z.string().optional(), description: z.string().optional(), parentId: z.string().optional(), account: accountField }),
  kind: 'write',
  async handler(input, ctx) {
    if (input.title === undefined && input.description === undefined && !input.parentId) throw invalid('Give at least one of title, description or parentId.');
    const account = await writeAccount(ctx, input.account, (a) => drive(ctx, a).getFile({ fileId: input.fileId }));
    await refuseSharedFolder(ctx, 'update_file', account, input.parentId, input.fileId);
    const file = await audited(ctx, 'update_file', account, input.fileId, idOf, () =>
      drive(ctx, account).updateFile({
        fileId: input.fileId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
      }),
    );
    return tag(file, account);
  },
});
