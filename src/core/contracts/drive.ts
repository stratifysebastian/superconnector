import type { Page } from './calendar';

/**
 * Drive shapes mirror the built-in connector's flattened output (docs/builtin-tools/drive.json), not raw
 * Drive v3 resources. Adapters (live and mock) do the mapping.
 */
export interface GFile {
  id: string;
  title: string;
  mimeType: string;
  fileExtension?: string;
  fileSize?: string;
  createdTime?: string;
  modifiedTime?: string;
  viewedByMeTime?: string;
  /** Not in the built-in output; kept so list_recent_files can merge on the same key Drive sorted by. */
  modifiedByMeTime?: string;
  sharedWithMeTime?: string;
  owner?: string;
  parentId?: string;
  canAddChildren?: boolean;
  viewUrl?: string;
  resourceUri: string; // googledrive://file/<id>
  contentSnippet?: string;
}

export interface GPermission {
  displayName?: string;
  emailAddress?: string;
  role: string;
  type: string;
}

export type RecentOrder = 'recency' | 'lastModified' | 'lastModifiedByMe';

export interface DriveAdapter {
  /** `q` is Drive v3 query syntax, already translated and validated by the tool. */
  searchFiles(p: { q: string; pageSize: number; pageToken?: string; orderByModified: boolean }): Promise<Page<GFile>>;
  listRecent(p: { orderBy: RecentOrder; pageSize: number; pageToken?: string }): Promise<Page<GFile>>;
  /** Null when this account cannot see the file. With snippetChars, Google-native files get a contentSnippet. */
  getFile(p: { fileId: string; snippetChars?: number }): Promise<GFile | null>;
  getPermissions(p: { fileId: string }): Promise<GPermission[] | null>;
  /**
   * Raw bytes, capped at maxBytes. Google-native files are exported (exportMimeType, else a text type);
   * others are fetched with alt=media. Null when not visible.
   */
  download(p: { fileId: string; exportMimeType?: string; revisionId?: string; maxBytes: number }): Promise<{
    bytes: Uint8Array;
    mimeType: string;
    title: string;
    sourceMimeType: string;
    viewUrl?: string;
  } | null>;
  /** True when the folder is shared with anyone besides its owner. My Drive root ('root') is never shared. */
  isSharedFolder(p: { folderId: string }): Promise<boolean>;
  createFile(p: {
    title: string;
    parentId?: string;
    /** Google-native type to create empty (Docs/Sheets/Slides/folder), when there is no content. */
    mimeType?: string;
    content?: { bytes: Uint8Array; contentType: string };
    /** Convert uploaded content to the matching Google type (the built-in default). */
    convert: boolean;
  }): Promise<GFile>;
  copyFile(p: { fileId: string; title?: string; parentId?: string }): Promise<GFile>;
  /** Metadata only: title, description, and moving to a new parent (replacing the current ones). */
  updateFile(p: { fileId: string; title?: string; description?: string; parentId?: string }): Promise<GFile>;
}
