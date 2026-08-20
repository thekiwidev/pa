// A thin Gmail REST client. No "use node", no SDK.
//
// This is the §0.2 compute argument applied: the googleapis package needs the
// Node runtime at 512 MB against a 20 GB-hour monthly budget — roughly 39
// hours of action time versus 312 in V8 — to call a handful of endpoints with
// a bearer token and JSON bodies.

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`gmail ${status}: ${body.slice(0, 300)}`);
    this.name = "GmailApiError";
  }
  /** 401 means the access token is stale or the grant is gone. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

async function gmailFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as T;
}

export async function getProfile(
  accessToken: string,
): Promise<{ emailAddress: string; historyId?: string }> {
  return await gmailFetch(accessToken, "/profile");
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

/**
 * `includeSpamTrash: true` is THE FEATURE, not a detail.
 *
 * users.messages.list excludes SPAM and TRASH by default, so the obvious
 * implementation silently misses every buried interview email — the exact
 * failure this project exists to prevent. Do not add labelIds: ["INBOX"].
 */
export async function listMessages(
  accessToken: string,
  options: { query: string; maxResults: number; pageToken?: string },
): Promise<{ messages?: GmailMessageRef[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    includeSpamTrash: "true",
    q: options.query,
    maxResults: String(options.maxResults),
  });
  if (options.pageToken) params.set("pageToken", options.pageToken);

  return await gmailFetch(accessToken, `/messages?${params.toString()}`);
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** `format=full` gives headers plus body parts without the raw MIME blob. */
export async function getMessage(
  accessToken: string,
  id: string,
): Promise<GmailMessage> {
  return await gmailFetch(accessToken, `/messages/${id}?format=full`);
}
