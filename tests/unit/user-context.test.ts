import { describe, expect, test } from "bun:test";
import {
  CONTEXT_CATEGORIES,
  MAX_CONTEXT_ENTRIES,
  MAX_ENTRY_CHARS,
  normalizeCategory,
  renderUserContext,
  type ContextEntry,
} from "../../convex/lib/userContext";

const entry = (over: Partial<ContextEntry> = {}): ContextEntry => ({
  category: "profile",
  text: "Frontend engineer, mostly React and TypeScript",
  ...over,
});

describe("normalizeCategory", () => {
  test("accepts a known category in any case", () => {
    expect(normalizeCategory("PROFILE")).toBe("profile");
    expect(normalizeCategory("Working Style")).toBe("working_style");
  });

  test("falls back to 'other' rather than rejecting an unknown one", () => {
    // A fact the user volunteered must never be DROPPED because it did not
    // fit a bucket. Losing it is worse than filing it imperfectly.
    expect(normalizeCategory("astrological sign")).toBe("other");
  });
});

describe("renderUserContext", () => {
  test("says so explicitly when nothing is known yet", () => {
    expect(renderUserContext([])).toContain("(nothing recorded yet)");
  });

  test("groups by category rather than emitting a flat list", () => {
    const out = renderUserContext([
      entry({ category: "profile", text: "Frontend engineer" }),
      entry({ category: "preferences", text: "Prefers short replies" }),
    ]);
    expect(out).toContain("PROFILE");
    expect(out).toContain("PREFERENCES");
    expect(out.indexOf("PROFILE")).toBeLessThan(out.indexOf("PREFERENCES"));
  });

  test("renders every entry's text verbatim", () => {
    const out = renderUserContext([entry({ text: "Based in Lagos, WAT" })]);
    expect(out).toContain("Based in Lagos, WAT");
  });
});

describe("bounds", () => {
  test("the entry cap is small enough to render every message", () => {
    // This is not arbitrary: MAX_CONTEXT_ENTRIES * MAX_ENTRY_CHARS is the
    // worst-case tokens added to EVERY planning call. Keep the product low.
    expect(MAX_CONTEXT_ENTRIES * MAX_ENTRY_CHARS).toBeLessThan(12_000);
  });

  test("every category is lower_snake_case", () => {
    for (const c of CONTEXT_CATEGORIES) expect(c).toMatch(/^[a-z_]+$/);
  });
});
