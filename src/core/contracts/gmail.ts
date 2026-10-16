import type { Page } from './calendar';

/**
 * Gmail shapes mirror the built-in connector's flattened output (docs/builtin-tools/gmail.json), not raw
 * Gmail API resources. Adapters (live and mock) do the mapping, so tool handlers only add account tags.
 */
export type MessageFormat = 'MINIMAL' | 'FULL_CONTENT' | 'METADATA_ONLY' | 'PLAIN_TEXT';

export interface GAttachmentMeta {
  id?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface GMessage {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate: string; // epoch ms as a string, as Gmail returns it
  date: string; // RFC3339 UTC, derived from internalDate
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  labelIds?: string[];
  sizeEstimate?: number;
  viewUrl: string;
  subject?: string; // MINIMAL and above
  snippet?: string; // MINIMAL and above
  plaintextBody?: string; // PLAIN_TEXT, FULL_CONTENT
  htmlBody?: string; // FULL_CONTENT
  attachmentIds?: string[];
  attachments?: GAttachmentMeta[];
}

export interface GThread {
  id: string;
  messageCount: number;
  messages: GMessage[];
  viewUrl: string;
}

export interface GDraft {
  id: string;
  messageId: string;
  threadId: string;
  date?: string;
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  labelIds?: string[];
  viewUrl: string;
  subject?: string;
  plaintextBody?: string;
}

export interface GLabel {
  labelId: string;
  name: string;
  labelType: 'SYSTEM' | 'USER';
  labelListVisibility?: 'LABEL_SHOW' | 'LABEL_SHOW_IF_UNREAD' | 'LABEL_HIDE';
  messageListVisibility?: 'SHOW' | 'HIDE';
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: { backgroundColor?: string; textColor?: string };
  colorPreset?: string;
}

export interface DraftAttachment {
  content: string; // base64
  filename?: string;
  mimeType?: string;
  inline?: boolean;
}

/** A draft's content. There is deliberately no send flag: drafts are only ever saved. */
export interface DraftContent {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: DraftAttachment[];
}

export interface LabelWrite {
  displayName?: string;
  labelListVisibility?: 'LABEL_SHOW' | 'LABEL_SHOW_IF_UNREAD' | 'LABEL_HIDE';
  messageListVisibility?: 'SHOW' | 'HIDE';
  colorPreset?: string;
}

export interface GmailAdapter {
  /** threads.list then a metadata fetch per thread. Newest first (Gmail's own order). */
  searchThreads(p: {
    q?: string;
    pageSize: number;
    pageToken?: string;
    includeTrash?: boolean;
    view: 'MINIMAL' | 'METADATA_ONLY';
  }): Promise<Page<GThread> & { resultSizeEstimate?: number }>;
  /** Null when it does not exist on this account. */
  getThread(p: { threadId: string; format: MessageFormat }): Promise<GThread | null>;
  getMessage(p: { messageId: string; format: MessageFormat }): Promise<GMessage | null>;
  listDrafts(p: { q?: string; pageSize: number; pageToken?: string; full: boolean }): Promise<Page<GDraft>>;
  getDraft(p: { draftId: string; format: MessageFormat }): Promise<GDraft | null>;
  /**
   * Saves a new draft. With replyToMessageId the draft joins that message's thread with In-Reply-To and
   * References set. Never sent.
   */
  createDraft(p: DraftContent & { replyToMessageId?: string }): Promise<GDraft>;
  /** Merge semantics of the built-in: provided fields replace, omitted fields keep. Attachments are replaced. */
  updateDraft(p: DraftContent & { draftId: string }): Promise<GDraft>;
  listLabels(): Promise<GLabel[]>;
  createLabel(p: LabelWrite & { displayName: string; autoCreateParentLabels?: boolean }): Promise<GLabel>;
  updateLabel(p: LabelWrite & { labelId: string }): Promise<GLabel>;
  /** messages.modify. TRASH may never appear in either list (enforced again by the endpoint policy). */
  modifyMessage(p: { messageId: string; add?: string[]; remove?: string[] }): Promise<GMessage>;
  modifyThread(p: { threadId: string; add?: string[]; remove?: string[] }): Promise<GThread>;
}
