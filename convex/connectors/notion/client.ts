// A thin Notion REST client. No SDK, one host, four operations.
//
// AUTH: an internal integration ("connection") token, not OAuth and not a
// personal access token. There is one user and one workspace, so a single
// token is the whole credential — same call Phase 16 makes for Linear.
//
// The token alone sees NOTHING. The notes page or database must be shared
// with the integration in Notion's UI (page -> ... -> Connections). That is
// Notion's design and the most common setup mistake, and it fails as a 404
// that reads exactly like a wrong id.
//
// NOTES_PARENT: either an ordinary page (notes become child pages) or a
// database (notes become rows). Both work; `parentKind` probes which.

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

  /** A revoked token, or a page/database never shared with the integration. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** What to say to the user. Never implies the note does not exist. */
  get userFacing(): string {
    if (this.isAuthFailure) {
      return (
        "I couldn't reach your Notion — the integration token was rejected. " +
        "Check it is still valid and that your notes page is shared with it."
      );
    }
    if (this.status === 404) {
      return "I couldn't reach your Notion notes page — it may have been moved, deleted, or unshared from the integration.";
    }
    return "I couldn't reach Notion just now, so I can't tell you what's saved there.";
  }
}

function requireToken(): string {
  const token = process.env.NOTION_API_KEY;
  if (!token) {
    throw new Error(
      "Notion isn't set up yet. Set NOTION_API_KEY to your integration token.",
    );
  }
  return token;
}

/** The page or database notes are written under. */
function requireParentId(): string {
  const id = process.env.NOTION_NOTES_DATABASE_ID;
  if (!id) {
    throw new Error(
      "Notion isn't set up yet. Set NOTION_NOTES_DATABASE_ID to the id of the " +
        "Notion page (or database) your notes should live under.",
    );
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
 * Whether the configured id names a DATABASE or an ordinary PAGE.
 *
 * Both are legitimate homes for notes and the setup instructions for a page
 * are shorter, so rather than insisting on one, this probes. Notion answers
 * `GET /databases/{id}` with 404 for a page id, which is the whole detection.
 *
 * Not cached: it is one small request, it self-heals if the id is later
 * changed from one to the other, and caching it would mean a stale kind
 * surviving a reconfiguration — the classic shape of a bug nobody can explain.
 */
async function parentKind(): Promise<"database" | "page"> {
  try {
    await notionFetch(`/databases/${requireParentId()}`, { method: "GET" });
    return "database";
  } catch (error) {
    if (error instanceof NotionUnavailable && (error.status === 404 || error.status === 400)) {
      return "page";
    }
    throw error;
  }
}

/**
 * Create a note under the configured parent.
 *
 * Notion caps `children` at 100 blocks per request. A longer note has its
 * first 100 created with the page and the rest appended — splitting rather
 * than dropping, same reason blocks.ts splits a long line.
 */
export async function createNote(args: {
  title: string;
  markdown: string;
}): Promise<SavedNote> {
  const blocks = markdownToBlocks(args.markdown);
  const parentId = requireParentId();
  const kind = await parentKind();
  const title = args.title.slice(0, 200);

  // A database row carries its title as a PROPERTY; a child page carries it
  // as `properties.title`. Same field name, different parent — Notion's own
  // asymmetry, not ours.
  const body =
    kind === "database"
      ? {
          parent: { database_id: parentId },
          // The title property's NAME varies per database; the property id
          // "title" addresses whichever column is the title, which is the one
          // handle stable across differently-configured databases.
          properties: { title: { title: [{ type: "text", text: { content: title } }] } },
          children: blocks.slice(0, 100),
        }
      : {
          parent: { page_id: parentId },
          properties: { title: { title: [{ type: "text", text: { content: title } }] } },
          children: blocks.slice(0, 100),
        };

  const page = await notionFetch<{ id: string; url: string }>("/pages", {
    method: "POST",
    body,
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
 * Find notes by title.
 *
 * Two paths because the parent can be either kind. Both stay scoped to the
 * one place the user designated: a database query cannot see outside its
 * database, and the page path filters `/search` down to children of the
 * configured page — so sharing something else with the integration later
 * cannot leak into notes.
 */
export async function searchNotes(query: string, limit: number): Promise<NoteSummary[]> {
  const parentId = requireParentId();
  const trimmed = query.trim();
  const pageSize = Math.min(limit, 25);

  if ((await parentKind()) === "database") {
    const body: Record<string, unknown> = {
      page_size: pageSize,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    };
    // A title filter, not full text: Notion's database query cannot search
    // page BODIES. So notes are found by what they are called, and note.get
    // reads the body — which is why the tool description tells the model to
    // search broadly and then read.
    if (trimmed.length > 0) {
      body.filter = { property: "title", title: { contains: trimmed } };
    }

    const result = await notionFetch<{ results: NotionPage[] }>(
      `/databases/${parentId}/query`,
      { method: "POST", body },
    );
    return result.results.map(toSummary);
  }

  // Page parent. /v1/search matches TITLES across everything the integration
  // can see — which is only what has been shared with it — and the results
  // are then narrowed to children of the configured page, so sharing
  // something else with the integration later cannot leak into notes.
  const result = await notionFetch<{ results: (NotionPage & { parent?: { page_id?: string } })[] }>(
    "/search",
    {
      method: "POST",
      body: {
        query: trimmed,
        page_size: 100,
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
      },
    },
  );

  const wanted = normalizeId(parentId);
  return result.results
    .filter((p) => normalizeId(p.parent?.page_id ?? "") === wanted)
    .slice(0, pageSize)
    .map(toSummary);
}

/** Notion returns ids hyphenated and accepts them either way. */
function normalizeId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

function toSummary(page: NotionPage): NoteSummary {
  return {
    pageId: page.id,
    url: page.url,
    title: titleOf(page),
    lastEditedAt: page.last_edited_time,
  };
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

/** Cheap liveness probe: does the token still see the configured parent, and
 *  is it a database or a page? */
export async function checkAccess(): Promise<{ ok: true; title: string; kind: string }> {
  const parentId = requireParentId();

  if ((await parentKind()) === "database") {
    const db = await notionFetch<{ title?: { plain_text?: string }[] }>(
      `/databases/${parentId}`,
      { method: "GET" },
    );
    return {
      ok: true,
      kind: "database",
      title: (db.title ?? []).map((t) => t.plain_text ?? "").join("") || "(untitled database)",
    };
  }

  const page = await notionFetch<NotionPage>(`/pages/${parentId}`, { method: "GET" });
  return { ok: true, kind: "page", title: titleOf(page) };
}
