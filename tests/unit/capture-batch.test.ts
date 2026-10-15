import { describe, expect, test } from "bun:test";
import {
  normalizeBatch,
  renderBatchMarkdown,
  describeBatch,
  captureKey,
  MAX_CAPTURE_ITEMS,
} from "../../convex/lib/capture/batch";

describe("normalizeBatch — nothing is lost quietly", () => {
  test("keeps every distinct item, in order", () => {
    const out = normalizeBatch([
      { title: "Arrival" },
      { title: "Dune", detail: "2021" },
      { title: "Sicario" },
    ]);
    expect(out.items.map((i) => i.title)).toEqual(["Arrival", "Dune", "Sicario"]);
    expect(out.items[1]!.detail).toBe("2021");
  });

  test("a ten-slide carousel yields ten items, not the first few", () => {
    // The whole point of the feature: "if ten movies are identified across
    // multiple images, attempt to process all ten".
    const ten = Array.from({ length: 10 }, (_, i) => ({ title: `Film ${i + 1}` }));
    expect(normalizeBatch(ten).items).toHaveLength(10);
  });

  test("a duplicate is collapsed AND reported", () => {
    const out = normalizeBatch([
      { title: "Arrival" },
      { title: "arrival" },
      { title: "Arrival!" },
    ]);
    expect(out.items).toHaveLength(1);
    // Reported, not silent — a carousel repeating a title is worth knowing.
    expect(out.duplicates).toEqual(["arrival", "Arrival!"]);
  });

  test("overflow is reported rather than silently truncated", () => {
    const many = Array.from({ length: MAX_CAPTURE_ITEMS + 5 }, (_, i) => ({
      title: `Item ${i}`,
    }));
    const out = normalizeBatch(many);
    expect(out.items).toHaveLength(MAX_CAPTURE_ITEMS);
    expect(out.overflow).toBe(5);
  });

  test("blank and whitespace-only titles are dropped, not kept as empties", () => {
    const out = normalizeBatch([{ title: "" }, { title: "   " }, { title: "Real" }]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.title).toBe("Real");
  });

  test("a title of pure punctuation is not an item", () => {
    expect(normalizeBatch([{ title: "!!!" }, { title: "---" }]).items).toEqual([]);
  });

  test("whitespace inside a title is collapsed", () => {
    expect(normalizeBatch([{ title: "  Blade   Runner\n2049 " }]).items[0]!.title).toBe(
      "Blade Runner 2049",
    );
  });

  test("absurdly long values are capped rather than filling a card", () => {
    const out = normalizeBatch([{ title: "x".repeat(500), detail: "y".repeat(2000) }]);
    expect(out.items[0]!.title.length).toBeLessThanOrEqual(200);
    expect(out.items[0]!.detail!.length).toBeLessThanOrEqual(500);
  });

  test("an item with no detail carries no detail key at all", () => {
    expect(normalizeBatch([{ title: "Solo" }]).items[0]).toEqual({ title: "Solo" });
  });

  test("an empty proposal is an empty batch, not an error", () => {
    expect(normalizeBatch([])).toEqual({ items: [], duplicates: [], overflow: 0 });
  });
});

describe("captureKey", () => {
  test("ignores case, punctuation and spacing", () => {
    expect(captureKey("The Matrix")).toBe(captureKey("the  matrix"));
    expect(captureKey("Wall-E")).toBe(captureKey("WALL E"));
  });

  test("different titles stay different", () => {
    expect(captureKey("Dune")).not.toBe(captureKey("Dune Part Two"));
  });
});

describe("renderBatchMarkdown", () => {
  test("one note holds the whole list, as bullets", () => {
    const md = renderBatchMarkdown([
      { title: "Arrival", detail: "2016" },
      { title: "Dune" },
    ]);
    expect(md).toBe("- **Arrival** — 2016\n- **Dune**");
  });

  test("the source is recorded so the list can be traced back", () => {
    const md = renderBatchMarkdown([{ title: "Dune" }], {
      url: "https://instagram.com/p/abc",
      author: "filmclub",
    });
    expect(md).toContain("Source: filmclub — https://instagram.com/p/abc");
  });

  test("no source means no dangling Source line", () => {
    expect(renderBatchMarkdown([{ title: "Dune" }])).not.toContain("Source:");
  });
});

describe("describeBatch", () => {
  test("names the count and the destination", () => {
    expect(describeBatch(5, "notes", "Movies")).toBe("5 items → your Movies notes");
    expect(describeBatch(1, "tasks")).toBe("1 item → your task board");
    expect(describeBatch(3, "tasks", "pa")).toBe("3 items → your task board, labelled pa");
  });

  test("singular and plural are both right", () => {
    expect(describeBatch(1, "notes")).toContain("1 item →");
    expect(describeBatch(2, "notes")).toContain("2 items →");
  });
});
