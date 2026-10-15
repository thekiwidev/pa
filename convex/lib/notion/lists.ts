// Pure. Notion "list" databases: Movies, Tools, Reading. Which one a name
// means, which columns are which, and the shape of a row.

/**
 * NOTION_LISTS='{"movies":"<db id>","tools":"<db id>"}'. Keys are matched
 * loosely so "movie", "Movies" and "my movies list" all find "movies".
 */
export function parseNotionLists(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k.trim().toLowerCase()] = v.trim().replace(/-/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveListName(lists: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase().replace(/\b(my|list|the|to|watch)\b/g, "").replace(/[^a-z0-9]/g, "");
  if (!wanted) return null;
  for (const key of Object.keys(lists)) {
    const k = key.replace(/[^a-z0-9]/g, "");
    if (k === wanted || k.replace(/s$/, "") === wanted.replace(/s$/, "")) return key;
  }
  for (const key of Object.keys(lists)) {
    const k = key.replace(/[^a-z0-9]/g, "");
    if (wanted.includes(k.replace(/s$/, "")) || k.includes(wanted.replace(/s$/, ""))) return key;
  }
  return null;
}

export interface ListColumns {
  title: string;
  status?: { name: string; kind: "status" | "select"; options: string[] };
  source?: string;
  detail?: string;
  type?: { name: string; options: string[] };
  added?: string;
}

type Prop = { type?: string; select?: { options?: { name: string }[] }; status?: { options?: { name: string }[] } };

/** Find the columns by TYPE first, then by name, so a renamed column still works. */
export function pickListColumns(properties: Record<string, Prop>): ListColumns | null {
  const entries = Object.entries(properties);
  const title = entries.find(([, p]) => p.type === "title")?.[0];
  if (!title) return null;
  const byName = (re: RegExp, types: string[]) =>
    entries.find(([n, p]) => re.test(n) && types.includes(p.type ?? ""))?.[0];

  const statusName = byName(/status|state|watched|done/i, ["status", "select"]);
  const statusProp = statusName ? properties[statusName] : undefined;
  const typeName = byName(/^type$|kind|category/i, ["select"]);
  return {
    title,
    ...(statusName && statusProp
      ? {
          status: {
            name: statusName,
            kind: statusProp.type === "status" ? "status" : "select",
            options: (statusProp.type === "status" ? statusProp.status?.options : statusProp.select?.options)?.map((o) => o.name) ?? [],
          },
        }
      : {}),
    ...(byName(/source|link|url/i, ["url"]) ? { source: byName(/source|link|url/i, ["url"]) } : {}),
    ...(byName(/detail|note|year|what|description/i, ["rich_text"])
      ? { detail: byName(/detail|note|year|what|description/i, ["rich_text"]) }
      : {}),
    ...(typeName ? { type: { name: typeName, options: properties[typeName]?.select?.options?.map((o) => o.name) ?? [] } } : {}),
    ...(byName(/added|saved|date/i, ["date"]) ? { added: byName(/added|saved|date/i, ["date"]) } : {}),
  };
}

/** "To watch" / "Not started" / first option: where a new row starts. */
export function initialStatus(options: string[]): string | undefined {
  return (
    options.find((o) => /to ?watch|to ?read|to ?try|not started|todo|to do|backlog|new/i.test(o)) ?? options[0]
  );
}

/** Is a row finished (watched, read, done)? */
export function isFinishedStatus(status: string | undefined): boolean {
  return !!status && /watched|done|read|finished|complete|tried|archived/i.test(status);
}

/** The option that means "finished" (Watched, Done, Read), if the list has one. */
export function finishedStatus(options: string[]): string | undefined {
  return options.find((o) => isFinishedStatus(o));
}

export function buildRowProperties(
  cols: ListColumns,
  row: { name: string; detail?: string; sourceUrl?: string; type?: string; addedIso?: string },
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [cols.title]: { title: [{ text: { content: row.name.slice(0, 200) } }] },
  };
  if (cols.detail && row.detail) props[cols.detail] = { rich_text: [{ text: { content: row.detail.slice(0, 1800) } }] };
  if (cols.source && row.sourceUrl) props[cols.source] = { url: row.sourceUrl };
  if (cols.status) {
    const start = initialStatus(cols.status.options);
    if (start) props[cols.status.name] = cols.status.kind === "status" ? { status: { name: start } } : { select: { name: start } };
  }
  if (cols.type && row.type) {
    const match = cols.type.options.find((o) => o.toLowerCase().startsWith(row.type!.toLowerCase().slice(0, 4)));
    if (match) props[cols.type.name] = { select: { name: match } };
  }
  if (cols.added && row.addedIso) props[cols.added] = { date: { start: row.addedIso } };
  return props;
}
