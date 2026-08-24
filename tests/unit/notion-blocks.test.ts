import { describe, expect, test } from "bun:test";
import {
  RICH_TEXT_LIMIT,
  blocksToMarkdown,
  markdownToBlocks,
} from "../../convex/lib/notion/blocks";

const textOf = (block: unknown): string => {
  const b = block as Record<string, any>;
  const type = b.type as string;
  return (b[type]?.rich_text ?? []).map((r: any) => r.text.content).join("");
};
const typeOf = (block: unknown) => (block as { type: string }).type;

describe("markdownToBlocks", () => {
  test("a paragraph becomes a paragraph block", () => {
    const blocks = markdownToBlocks("Hello there");
    expect(blocks).toHaveLength(1);
    expect(typeOf(blocks[0])).toBe("paragraph");
    expect(textOf(blocks[0])).toBe("Hello there");
  });

  test("headings map to Notion's three levels", () => {
    const blocks = markdownToBlocks("# One\n## Two\n### Three");
    expect(blocks.map(typeOf)).toEqual(["heading_1", "heading_2", "heading_3"]);
  });

  test("heading levels past three clamp to heading_3", () => {
    // Notion has exactly three. Silently dropping a #### would lose the line.
    expect(typeOf(markdownToBlocks("#### Four")[0])).toBe("heading_3");
  });

  test("bullets and numbers become list items", () => {
    const blocks = markdownToBlocks("- a\n* b\n1. c");
    expect(blocks.map(typeOf)).toEqual([
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
    ]);
    expect(textOf(blocks[0])).toBe("a");
    expect(textOf(blocks[2])).toBe("c");
  });

  test("checkboxes become to_do blocks with their state", () => {
    const blocks = markdownToBlocks("- [ ] open\n- [x] done");
    expect(blocks.map(typeOf)).toEqual(["to_do", "to_do"]);
    expect((blocks[0] as any).to_do.checked).toBe(false);
    expect((blocks[1] as any).to_do.checked).toBe(true);
    expect(textOf(blocks[1])).toBe("done");
  });

  test("a fenced block becomes one code block, not one per line", () => {
    const blocks = markdownToBlocks("```ts\nconst a = 1;\nconst b = 2;\n```");
    expect(blocks).toHaveLength(1);
    expect(typeOf(blocks[0])).toBe("code");
    expect(textOf(blocks[0])).toBe("const a = 1;\nconst b = 2;");
    expect((blocks[0] as any).code.language).toBe("typescript");
  });

  test("an unknown fence language falls back to plain text", () => {
    // Notion rejects a language it does not know, failing the whole request.
    expect((markdownToBlocks("```wat\nx\n```")[0] as any).code.language).toBe("plain text");
  });

  test("a quote becomes a quote block", () => {
    expect(typeOf(markdownToBlocks("> quoted")[0])).toBe("quote");
  });

  test("a horizontal rule becomes a divider", () => {
    expect(typeOf(markdownToBlocks("---")[0])).toBe("divider");
  });

  test("blank lines do not become empty paragraphs", () => {
    expect(markdownToBlocks("a\n\n\n\nb")).toHaveLength(2);
  });

  test("a line longer than the rich-text limit is split, not truncated", () => {
    // Notion rejects rich_text over 2000 chars. Losing the tail of a note
    // silently is worse than splitting it across blocks.
    const long = "x".repeat(RICH_TEXT_LIMIT * 2 + 50);
    const blocks = markdownToBlocks(long);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((b) => textOf(b).length <= RICH_TEXT_LIMIT)).toBe(true);
    expect(blocks.map(textOf).join("")).toBe(long);
  });

  test("empty input produces no blocks", () => {
    expect(markdownToBlocks("")).toEqual([]);
    expect(markdownToBlocks("   \n\n ")).toEqual([]);
  });
});

describe("blocksToMarkdown", () => {
  test("round-trips the shapes we write", () => {
    const md = "# Title\n\nA paragraph.\n\n- one\n- two\n\n> quoted";
    expect(blocksToMarkdown(markdownToBlocks(md))).toBe(
      "# Title\nA paragraph.\n- one\n- two\n> quoted",
    );
  });

  test("renders to_do state", () => {
    expect(blocksToMarkdown(markdownToBlocks("- [x] done"))).toBe("- [x] done");
  });

  test("ignores a block type it does not know rather than throwing", () => {
    // Pages are edited by a human in Notion, so unknown types WILL appear.
    expect(blocksToMarkdown([{ type: "child_database", child_database: {} }])).toBe("");
  });

  test("survives a malformed block", () => {
    expect(() => blocksToMarkdown([{}, null, "nonsense"])).not.toThrow();
  });
});
