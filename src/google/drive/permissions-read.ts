import type { GoogleHttp } from '@/core/contracts/adapter';
import type { GPermission } from '@/core/contracts/drive';
import { ProviderError } from '@/core/errors';
import { driveUrl } from '../endpoints/urls';

/** The only Drive path that names permissions: a read-only list. Used by the endpoint rule and by the reader below. */
export const PERMISSIONS_LIST_PATH = /^\/drive\/v3\/files\/[^/]+\/permissions$/;

/** All pages of a file's permissions, or null when the account cannot see the file. */
export async function readPermissions(http: GoogleHttp, fileId: string): Promise<GPermission[] | null> {
  const out: GPermission[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const r: { permissions?: GPermission[]; nextPageToken?: string } = await http.json({
        method: 'GET',
        url: driveUrl(`/files/${encodeURIComponent(fileId)}/permissions`),
        query: { fields: 'nextPageToken,permissions(displayName,emailAddress,role,type)', pageSize: 100, pageToken, supportsAllDrives: true },
      });
      out.push(...(r.permissions ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'not_found') return null;
    throw e;
  }
  return out;
}
