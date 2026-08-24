// A thin Notion REST client. No SDK, one host, four operations.
//
// AUTH: an internal integration token, not OAuth. There is one user and one
// workspace, so a personal token is the whole credential — same call Phase 16
// makes for Linear. The token must be given access to the notes database by
// sharing that database with the integration in Notion's UI; a token alone
// sees nothing, which is Notion's design and the most common setup mistake.

import { blocksToMarkdown, markdownToBlocks } from "../../lib/notion/blocks";

const BASE = "https://api.notion.com/v1";

/** Pinned. Notion breaks shapes between versions and dates the contract. */
const NOTION_VERSION = "2022-06-28";

/**
 * Notion is the ONLY home for notes — nothing is mirrored into Convex — so
 * telling an outage apart from an absence is a correctness requirement, not
 * politeness. "I don't have anything on that" when the token expired is a
 * false statement about the user's own data.
 */
export class NotionUnavailable extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`notion ${status}: ${body.slice(0, 300)}`);
    this.name = "NotionUnavailable";
  }

  /** A revoked token, or a database never shared with the integration. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** What to say to the user. Never implies the note does not exist. */
  get userFacing(): string {
    if (this.isAuthFailure) {
      return (
        "I couldn't reach your Notion — the integration token was rejected. " +
        "Check it is still valid and that the notes database is shared with it."
      );
    }
    if (this.status === 404) {
      return "I couldn't reach your Notion notes database — it may have been moved or unshared.";
    }
    return "I couldn't reach Notion just now, so I can't tell you what's saved there.";
  }
}

function requireToken(): string {
  const token = process.env.NOTION_API_KEY;
  if (!token) {
    throw new Error(
      "Notion isn't set up yet. Set NOTION_API_KEY and NOTION_NOTES_DATABASE_ID on the deployment.",
    );
  }
  return token;
}

function requireDatabaseId(): string {
  const id = process.env.NOTION_NOTES_DATABASE_ID;
  if (!id) {
    throw new Error("Notion isn't set up yet. Set NOTION_NOTES_DATABASE_ID on the deployment.");
  }
  return id;
}

async function notionFetch<T>(
  path: string,
  init: { method: "GET" | "POST" | "PATCH"; body?: unknown },
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new NotionUnavailable(res.status, await res.text());
  return (await res.json()) as T;
}

export interface SavedNote {
  pageId: string;
  url: string;
  title: string;
}

/**
 * Create a page in the notes database.
 *
 * Notion caps `children` at 100 blocks per request. A longer note has its
 * first 100 blocks created with the page and the rest appended — splitting
 * rather than dropping, same reason blocks.ts splits a long line.
 */
export async function createNote(args: {
  title: string;
  markdown: string;
  tags?: string[];
  sourceUrl?: string;
}): Promise<SavedNote> {
  const blocks = markdownToBlocks(args.markdown);

  const properties: Record<string, unknown> = {
    // The title property's NAME varies per database; Notion accepts the
    // property id "title" for whichever column is the title, which is the
    // one thing that is stable across differently-configured databases.
    title: { title: [{ type: "text", text: { content: args.title.slice(0, 200) } }] },
  };

  const page = await notionFetch<{ id: string; url: string }>("/pages", {
    method: "POST",
    body: {
      parent: { database_id: requireDatabaseId() },
      properties,
      children: blocks.slice(0, 100),
    },
  });

  for (let i = 100; i < blocks.length; i += 100) {
    await notionFetch(`/blocks/${page.id}/children`, {
      method: "PATCH",
      body: { children: blocks.slice(i, i + 100) },
    });
  }

  return { pageId: page.id, url: page.url, title: args.title };
}

interface NotionPage {
  id: string;
  url: string;
  properties?: Record<string, { title?: { plain_text?: string }[] }>;
  last_edited_time?: string;
}

function titleOf(page: NotionPage): string {
  for (const value of Object.values(page.properties ?? {})) {
    if (Array.isArray(value?.title) && value.title.length > 0) {
      return value.title.map((t) => t.plain_text ?? "").join("") || "(untitled)";
    }
  }
  return "(untitled)";
}

export interface NoteSummary {
  pageId: string;
  url: string;
  title: string;
  lastEditedAt?: string;
}

/**
 * Search the notes database.
 *
 * Notion's `/search` covers the whole workspace, which would surface pages
 * that have nothing to do with notes. Querying the database directly keeps
 * the blast radius to the one place the user designated.
 */
export async function searchNotes(query: string, limit: number): Promise<NoteSummary[]> {
  const body: Record<string, unknown> = {
    page_size: Math.min(limit, 25),
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  };

  const trimmed = query.trim();
  if (trimmed.length > 0) {
    // A title filter, not full text: Notion's database query cannot search
    // page BODIES. searchNotes therefore finds notes by what they are called,
    // and note.get reads the body — which is why the tool descriptions tell
    // the model to search broadly and then read.
    body.filter = { property: "title", title: { contains: trimmed } };
  }

  const result = await notionFetch<{ results: NotionPage[] }>(
    `/databases/${requireDatabaseId()}/query`,
    { method: "POST", body },
  );

  return result.results.map((page) => ({
    pageId: page.id,
    url: page.url,
    title: titleOf(page),
    lastEditedAt: page.last_edited_time,
  }));
}

/** A page's body as markdown. Untrusted content — it is whatever was written. */
export async function readNote(pageId: string): Promise<{ title: string; markdown: string; url: string }> {
  const [page, children] = await Promise.all([
    notionFetch<NotionPage>(`/pages/${pageId}`, { method: "GET" }),
    notionFetch<{ results: unknown[] }>(`/blocks/${pageId}/children?page_size=100`, {
      method: "GET",
    }),
  ]);

  return {
    title: titleOf(page),
    url: page.url,
    markdown: blocksToMarkdown(children.results),
  };
}

/** Cheap liveness probe: does the token still see the notes database? */
export async function checkAccess(): Promise<{ ok: true; title: string }> {
  const db = await notionFetch<{ title?: { plain_text?: string }[] }>(
    `/databases/${requireDatabaseId()}`,
    { method: "GET" },
  );
  return {
    ok: true,
    title: (db.title ?? []).map((t) => t.plain_text ?? "").join("") || "(untitled database)",
  };
}
