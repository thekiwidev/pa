import { describe, expect, test } from "bun:test";
import { buildDriveQuery, planRead, fileKind } from "../../convex/lib/drive/query";

describe("buildDriveQuery — trashed files are never searchable", () => {
  test("every query excludes the bin, even an empty one", () => {
    expect(buildDriveQuery({})).toBe("trashed = false");
  });

  test("the exclusion survives every other clause", () => {
    const q = buildDriveQuery({ name: "cv", text: "resume", ownedByMe: true });
    expect(q).toContain("trashed = false");
  });
});

describe("buildDriveQuery — typed fields become clauses", () => {
  test("a name search", () => {
    expect(buildDriveQuery({ name: "CV" })).toBe("trashed = false and name contains 'CV'");
  });

  test("a full-text search looks inside the file", () => {
    expect(buildDriveQuery({ text: "invoice" })).toBe(
      "trashed = false and fullText contains 'invoice'",
    );
  });

  test("ownership and mime type combine with AND, never OR", () => {
    const q = buildDriveQuery({
      name: "notes",
      mimeType: "application/vnd.google-apps.document",
      ownedByMe: true,
    });
    expect(q).toBe(
      "trashed = false and name contains 'notes' and " +
        "mimeType = 'application/vnd.google-apps.document' and 'me' in owners",
    );
    expect(q).not.toContain(" or ");
  });
});

describe("buildDriveQuery — a value cannot become a clause", () => {
  // Drive's q has no escape for a quote inside a literal, so a stray one
  // does not merely widen the search — it changes which clauses are joined.
  test("a quote cannot close the literal and add an OR", () => {
    const q = buildDriveQuery({ name: "a' or trashed = true or name contains '" });
    expect(q).toBe("trashed = false and name contains 'a or trashed = true or name contains'");
    // Exactly two quotes: the ones this module put there.
    expect(q.split("'").length - 1).toBe(2);
  });

  test("the trashed exclusion still stands after an injection attempt", () => {
    const q = buildDriveQuery({ text: "x' or trashed = true or fullText contains 'y" });
    expect(q.startsWith("trashed = false and")).toBe(true);
    expect(q.split("'").length - 1).toBe(2);
  });

  test("backslashes are stripped rather than passed through", () => {
    expect(buildDriveQuery({ name: "a\\'b" })).toBe("trashed = false and name contains 'a b'");
  });

  test("a value that is only punctuation contributes no clause", () => {
    expect(buildDriveQuery({ name: "'''" })).toBe("trashed = false");
  });

  test("whitespace is collapsed, not preserved", () => {
    expect(buildDriveQuery({ name: "  my    CV  " })).toBe("trashed = false and name contains 'my CV'");
  });
});

describe("planRead — what can actually be turned into text", () => {
  test("Google's own formats are exported, not downloaded", () => {
    // A Doc has no bytes; alt=media returns 403, which reads exactly like a
    // missing scope and is easy to misdiagnose as one.
    expect(planRead("application/vnd.google-apps.document")).toEqual({
      kind: "export",
      exportMimeType: "text/plain",
      label: "Google Doc",
    });
    expect(planRead("application/vnd.google-apps.spreadsheet")).toEqual({
      kind: "export",
      exportMimeType: "text/csv",
      label: "Google Sheet",
    });
  });

  test("files that are already text are downloaded", () => {
    for (const mime of ["text/plain", "text/markdown", "text/csv", "application/json"]) {
      expect(planRead(mime).kind).toBe("download");
    }
  });

  test("an unknown text/* subtype is still treated as text", () => {
    expect(planRead("text/x-something-new").kind).toBe("download");
  });

  test("a PDF says so, and points at the route that does work", () => {
    const plan = planRead("application/pdf");
    expect(plan.kind).toBe("unreadable");
    if (plan.kind === "unreadable") expect(plan.reason).toContain("Telegram");
  });

  test("media and folders are refused with a reason, not an error", () => {
    for (const mime of ["image/png", "video/mp4", "audio/mpeg"]) {
      expect(planRead(mime).kind).toBe("unreadable");
    }
    const folder = planRead("application/vnd.google-apps.folder");
    expect(folder.kind).toBe("unreadable");
    if (folder.kind === "unreadable") expect(folder.reason).toContain("folder");
  });

  test("an unrecognised type names itself in the reason", () => {
    const plan = planRead("application/x-weird");
    expect(plan.kind).toBe("unreadable");
    if (plan.kind === "unreadable") expect(plan.reason).toContain("application/x-weird");
  });
});

describe("fileKind — a word a person would use", () => {
  test("Google formats get their real names", () => {
    expect(fileKind("application/vnd.google-apps.document")).toBe("Google Doc");
    expect(fileKind("application/vnd.google-apps.spreadsheet")).toBe("Google Sheet");
    expect(fileKind("application/vnd.google-apps.folder")).toBe("Folder");
  });

  test("Office formats are described, not spelled out", () => {
    expect(
      fileKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("Word document");
    expect(fileKind("application/pdf")).toBe("PDF");
  });

  test("anything unrecognised is just a File, never a raw mime type", () => {
    expect(fileKind("application/x-weird")).toBe("File");
  });
});
