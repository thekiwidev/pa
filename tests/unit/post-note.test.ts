import { describe, expect, test } from "bun:test";
import { parsePostNote, pickCategory, postNoteInput, postNoteMarkdown, WRITE_POST_NOTE_SYSTEM } from "../../convex/lib/saved/note";

const reel = {
  platform: "instagram",
  url: "https://www.instagram.com/reel/DeiMd-GNHK0/",
  author: "@coach",
  caption: "The universe is testing you…",
  slides: [],
  videoTranscript: "About: ordering at a restaurant.\nPoints:\n1. Don't settle\nTranscript:\nWhen the waiter asks…",
  savedAtText: "Fri 16 Oct, 21:04",
  isVideo: true,
};

describe("pickCategory", () => {
  const existing = ["Library", "Work", "Personal", "Self-development"];
  test("snaps near spellings onto the existing section", () => {
    expect(pickCategory("self development", existing)).toBe("Self-development");
    expect(pickCategory("WORK", existing)).toBe("Work");
  });
  test("keeps a genuinely new section name", () => {
    expect(pickCategory("Relationships", existing)).toBe("Relationships");
  });
  test("no choice falls back to Library", () => {
    expect(pickCategory(undefined, existing)).toBe("Library");
  });
});

describe("parsePostNote", () => {
  test("reads the model's JSON", () => {
    const d = parsePostNote(
      'Here: {"title":"Ask for what you want","category":"self development","overview":"o","explanation":"p1\\n\\np2","points":[{"heading":"Don\'t settle","detail":"d"}],"lessons":["l"],"takeaways":["t"]}',
      { title: "x", categories: ["Self-development"] },
    );
    expect(d.title).toBe("Ask for what you want");
    expect(d.category).toBe("Self-development");
    expect(d.points).toEqual([{ heading: "Don't settle", detail: "d" }]);
  });
  test("bad JSON still produces a note from the stored title and summary", () => {
    const d = parsePostNote("not json", { title: "Stored", summary: "sum", categories: [] });
    expect(d.title).toBe("Stored");
    expect(d.overview).toBe("sum");
    expect(d.category).toBe("Library");
  });
});

describe("postNoteMarkdown", () => {
  const draft = parsePostNote(
    JSON.stringify({ title: "T", overview: "Overview.", explanation: "First.\n\nSecond.", points: [{ heading: "A", detail: "a" }, { heading: "B", detail: "b" }], lessons: ["L"], takeaways: ["K"] }),
    { title: "T", categories: [] },
  );
  test("has every section, in order, with the link as a source", () => {
    const md = postNoteMarkdown(draft, reel);
    const order = ["Source: https://www.instagram.com/reel/DeiMd-GNHK0/", "## Overview", "## Full explanation", "## The 2 points", "### 1. A", "### 2. B", "## Lessons", "## Key takeaways", "## Video notes and transcript", "When the waiter asks", "## Caption", "## Source"];
    let at = -1;
    for (const marker of order) {
      const i = md.indexOf(marker);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
  });
  test("copies every slide's text verbatim", () => {
    const md = postNoteMarkdown(draft, {
      ...reel,
      isVideo: false,
      videoTranscript: undefined,
      slides: [
        { index: 1, text: "15 GAPS\nthat ruin relationships" },
        { index: 2, text: "UPBRINGING\nOne sends money home every month" },
      ],
    });
    expect(md).toContain("## Slide text, word for word");
    expect(md).toContain("### Slide 2");
    expect(md).toContain("One sends money home every month");
    expect(md).toContain("post, 2 slides");
  });
});

test("the model gets every slide and the transcript, and is told not to skip points", () => {
  const input = postNoteInput({ ...reel, slides: [{ index: 1, text: "s1" }, { index: 2, text: "s2" }] }, [{ name: "e1" }]);
  expect(input).toContain("SLIDE 2:\ns2");
  expect(input).toContain("VIDEO NOTES AND TRANSCRIPT");
  expect(WRITE_POST_NOTE_SYSTEM).toContain("EVERY item");
});

import { importantLinkMarkdown } from "../../convex/lib/notion/links";
test("an important link carries what it is and when it was saved", () => {
  const md = importantLinkMarkdown({ url: "https://firs.gov.ng/taxpro", about: "Tax portal for filing my returns", savedAt: "Sat 17 Oct, 08:02" });
  expect(md.split("\n")).toEqual([
    "### Tax portal for filing my returns",
    "- Link: https://firs.gov.ng/taxpro",
    "- What it is: Tax portal for filing my returns",
    "- Saved: Sat 17 Oct, 08:02",
  ]);
});
