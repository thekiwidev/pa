// A thin Google Drive client. Read-only, by scope AND by construction —
// there is no create, no update, no share and no delete function in this
// file, so no caller can reach for one.
//
// The access token is always argument one. Same shape as gcal/client.ts and
// gmail/client.ts.

const BASE = "https://www.googleapis.com/drive/v3";

export class DriveApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`drive ${status}: ${body.slice(0, 300)}`);
    this.name = "DriveApiError";
  }
  get isScopeFailure() {
    return this.status === 403;
  }
}

async function driveFetch(accessToken: string, path: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new DriveApiError(res.status, await res.text());
  return res;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  owners?: { emailAddress?: string; displayName?: string }[];
}

/** The field mask. Requesting `*` returns a lot of bytes nobody reads. */
const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress,displayName)";

export async function searchFiles(
  accessToken: string,
  options: { query: string; limit?: number },
): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: options.query,
    // Newest first. "Find my latest CV" is answered by the ORDER as much as
    // by the query — the top result being the most recently edited is what
    // makes the list scannable.
    orderBy: "modifiedTime desc",
    pageSize: String(Math.min(options.limit ?? 10, 25)),
    fields: `files(${FILE_FIELDS})`,
    // Shared drives as well as My Drive — a work document is often not in
    // the personal one.
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await driveFetch(accessToken, `/files?${params.toString()}`);
  const data = (await res.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

export async function getFile(accessToken: string, fileId: string): Promise<DriveFile | null> {
  try {
    const params = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" });
    const res = await driveFetch(
      accessToken,
      `/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    );
    return (await res.json()) as DriveFile;
  } catch (error) {
    if (error instanceof DriveApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The text of a Google-native document, via export.
 *
 * A Doc has no bytes to download — `alt=media` returns a 403 for one, which
 * reads exactly like a missing scope and is easy to misdiagnose as one.
 */
export async function exportFileText(
  accessToken: string,
  fileId: string,
  exportMimeType: string,
  maxChars: number,
): Promise<string> {
  const params = new URLSearchParams({ mimeType: exportMimeType });
  const res = await driveFetch(
    accessToken,
    `/files/${encodeURIComponent(fileId)}/export?${params.toString()}`,
  );
  return capped(await res.text(), maxChars);
}

/** The raw bytes of a file that is already text. */
export async function downloadFileText(
  accessToken: string,
  fileId: string,
  maxChars: number,
): Promise<string> {
  const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
  const res = await driveFetch(
    accessToken,
    `/files/${encodeURIComponent(fileId)}?${params.toString()}`,
  );
  return capped(await res.text(), maxChars);
}

/**
 * Truncation is announced, never silent.
 *
 * A model handed the first 8 KB of a contract with no indication that it was
 * the first 8 KB will summarise it as though it were the whole thing.
 */
function capped(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[…truncated, ${text.length - maxChars} more characters]`;
}
