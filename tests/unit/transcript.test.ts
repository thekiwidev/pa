import { describe, expect, test } from "bun:test";
import {
  normalizeTranscript,
  chunkTranscript,
  ExtractionSchema,
  CHUNK_CHARS,
  attributeOwner,
} from "../../convex/lib/meetings/transcript";

describe("normalizeTranscript", () => {
  test("strips WebVTT cue numbers and timestamps", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Ade: I'll fix the FedEx response by Friday.

2
00:00:04.000 --> 00:00:07.000
Dash: I'll send the OTP tomorrow.`;
    const out = normalizeTranscript(vtt);
    expect(out).not.toContain("WEBVTT");
    expect(out).not.toContain("-->");
    expect(out).not.toMatch(/^\d+$/m);
    expect(out).toContain("Ade: I'll fix the FedEx response by Friday.");
  });

  test("strips SRT indices and timestamps", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Ade: Testing the server tomorrow.`;
    expect(normalizeTranscript(srt)).toBe("Ade: Testing the server tomorrow.");
  });

  test("leaves plain text alone", () => {
    expect(normalizeTranscript("Ade: hello\nDash: hi")).toBe("Ade: hello\nDash: hi");
  });

  test("collapses the blank-line noise transcript exporters love", () => {
    expect(normalizeTranscript("a\n\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("chunkTranscript", () => {
  test("a short transcript is one chunk", () => {
    expect(chunkTranscript("Ade: short")).toHaveLength(1);
  });

  test("splits a long transcript on speaker turns, never mid-line", () => {
    const line = "Ade: " + "x".repeat(200);
    const chunks = chunkTranscript(Array.from({ length: 200 }, () => line).join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    // The failure this guards: a chunk boundary inside a sentence loses the
    // commitment that straddles it. Every chunk must start at a speaker turn.
    for (const c of chunks) expect(c.startsWith("Ade:")).toBe(true);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS + 300);
  });

  test("no content is dropped across chunk boundaries", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `S${i}: ` + "y".repeat(200));
    const joined = chunkTranscript(lines.join("\n")).join("\n");
    for (const l of lines) expect(joined).toContain(l);
  });
});

describe("attributeOwner", () => {
  const aliases = ["ade", "adedotun", "ade gabriel"];

  test("matches the owner by any known alias, case-insensitively", () => {
    expect(attributeOwner("Adedotun", aliases)).toBe("owner");
    expect(attributeOwner("ADE", aliases)).toBe("owner");
  });

  test("anyone else is someone_else, not owner", () => {
    expect(attributeOwner("Dash", aliases)).toBe("someone_else");
  });

  test("an unattributed commitment is unknown, never silently the owner", () => {
    // Guessing "owner" here would manufacture a task the user never agreed
    // to. Unknown surfaces for confirmation instead.
    expect(attributeOwner("", aliases)).toBe("unknown");
    expect(attributeOwner(undefined, aliases)).toBe("unknown");
  });
});

describe("ExtractionSchema — the security boundary", () => {
  test("accepts a well-formed extraction", () => {
    const parsed = ExtractionSchema.safeParse({
      personalTldr: "You own the FedEx fix; Dash owes you the OTP.",
      commitments: [
        { owner: "owner", who: "Ade", what: "Fix the FedEx response", dueAt: "2026-08-22T09:00" },
      ],
      decisions: ["Ship behind a flag"],
      people: [{ name: "Dash", note: "handles OTP access" }],
      scheduling: [],
    });
    expect(parsed.success).toBe(true);
  });

  test("has NO field capable of expressing an external action", () => {
    // Invariant I-2's crash structure. A transcript saying "email the client"
    // has nowhere to put that instruction — it is inert by construction, not
    // by the prompt asking nicely.
    const keys = Object.keys(ExtractionSchema.shape);
    for (const forbidden of ["send", "email", "recipient", "to", "url", "tool", "execute"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test("rejects an unknown owner value", () => {
    const parsed = ExtractionSchema.safeParse({
      personalTldr: "x",
      commitments: [{ owner: "the_ceo", who: "X", what: "y" }],
      decisions: [],
      people: [],
      scheduling: [],
    });
    expect(parsed.success).toBe(false);
  });
});
