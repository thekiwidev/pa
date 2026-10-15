// Pure. No ctx, no fetch. Building Drive's `q` string from typed fields, and
// deciding what a file can be turned into.
//
// Same shape and same reason as lib/email/gmailQuery.ts: the model proposes
// FIELDS, this writes the query language. Drive's `q` is more dangerous than
// Gmail's, because a stray quote does not merely widen a search — it changes
// which clauses are joined. `name contains 'a' or trashed = true` would
// return the trash.

/**
 * Drive's `q` has no escape sequence for a single quote inside a literal, so
 * the character is removed rather than escaped. Losing an apostrophe from a
 * filename search is a slightly worse match; leaving one in is a different
 * query.
 */
function literal(value: string): string {
  return value.replaceAll("'", " ").replaceAll("\\", " ").trim().replace(/\s+/g, " ");
}

export interface DriveQueryInput {
  /** Words to look for in the file's name. */
  name?: string;
  /** Words to look for anywhere in the file, including its contents. */
  text?: string;
  /** Restrict to one Drive mime type. */
  mimeType?: string;
  /** Only files the user owns, rather than everything shared with them. */
  ownedByMe?: boolean;
}

/**
 * Trashed files are excluded ALWAYS and unconditionally.
 *
 * "Find my latest CV" returning a deleted draft, which is then attached to a
 * job application, is exactly the failure this connector must not have. It is
 * not a filter the caller can turn off, because there is no version of this
 * feature where searching the bin is correct.
 */
export function buildDriveQuery(input: DriveQueryInput): string {
  const clauses: string[] = ["trashed = false"];

  if (input.name) {
    const value = literal(input.name);
    if (value) clauses.push(`name contains '${value}'`);
  }
  if (input.text) {
    const value = literal(input.text);
    if (value) clauses.push(`fullText contains '${value}'`);
  }
  if (input.mimeType) {
    const value = literal(input.mimeType);
    if (value) clauses.push(`mimeType = '${value}'`);
  }
  if (input.ownedByMe) {
    clauses.push("'me' in owners");
  }

  return clauses.join(" and ");
}

// ── What a file can be turned into ────────────────────────────────────────

/** Google's own formats have no bytes to download — they must be exported. */
const GOOGLE_EXPORTS: Record<string, { mimeType: string; label: string }> = {
  "application/vnd.google-apps.document": { mimeType: "text/plain", label: "Google Doc" },
  "application/vnd.google-apps.spreadsheet": { mimeType: "text/csv", label: "Google Sheet" },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain", label: "Google Slides" },
};

/** Formats whose raw bytes are already text. */
const DIRECT_TEXT = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/rtf",
  "text/rtf",
]);

export type ReadPlan =
  | { kind: "export"; exportMimeType: string; label: string }
  | { kind: "download" }
  | { kind: "unreadable"; reason: string };

/**
 * How — or whether — this file's text can be obtained.
 *
 * Returning a typed "unreadable" rather than throwing is deliberate: the
 * caller has to tell the user *which* file it could not read and why, and a
 * thrown error at this point loses the filename.
 */
export function planRead(mimeType: string): ReadPlan {
  const exportable = GOOGLE_EXPORTS[mimeType];
  if (exportable) {
    return { kind: "export", exportMimeType: exportable.mimeType, label: exportable.label };
  }
  if (DIRECT_TEXT.has(mimeType)) return { kind: "download" };
  if (mimeType.startsWith("text/")) return { kind: "download" };

  if (mimeType === "application/pdf") {
    return {
      kind: "unreadable",
      reason: "it is a PDF — send it to me in Telegram and I can read it that way",
    };
  }
  if (mimeType.startsWith("image/") || mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
    return { kind: "unreadable", reason: "it is not a text document" };
  }
  if (mimeType === "application/vnd.google-apps.folder") {
    return { kind: "unreadable", reason: "it is a folder" };
  }
  return { kind: "unreadable", reason: `I cannot extract text from ${mimeType}` };
}

/** A short human word for a mime type, for listings. */
export function fileKind(mimeType: string): string {
  const exportable = GOOGLE_EXPORTS[mimeType];
  if (exportable) return exportable.label;
  if (mimeType === "application/vnd.google-apps.folder") return "Folder";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio";
  if (DIRECT_TEXT.has(mimeType) || mimeType.startsWith("text/")) return "Text";
  if (mimeType.includes("wordprocessing")) return "Word document";
  if (mimeType.includes("spreadsheet")) return "Spreadsheet";
  if (mimeType.includes("presentation")) return "Presentation";
  return "File";
}
