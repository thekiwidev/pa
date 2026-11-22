import { describe, expect, test } from "bun:test";
import { TOOL_META, TOOL_SCHEMAS } from "../../convex/lib/tools/catalog";
import { renderOutcomes } from "../../convex/lib/tools/outcomes";
import { DEFAULT_SECTIONS, nextSlot, slotsOf, type BriefConfig } from "../../convex/model/briefConfig";

describe("news tools in the catalog", () => {
  test("every news tool is read-only: nothing here reaches outside or destroys", () => {
    for (const name of ["news.brief", "interest.add", "interest.list", "interest.remove", "news.source.add", "news.source.list", "news.source.remove", "web.read"] as const) {
      expect(TOOL_META[name].consequential).toBe(false);
    }
  });
  test("web.read content is unknowable to the planner, so its planned reply is never shown", () => {
    expect(TOOL_META["web.read"].contentIsUnknowable).toBe(true);
  });
  test("web.read takes 1 to 4 urls and a question", () => {
    const s = TOOL_SCHEMAS["web.read"];
    expect(s.safeParse({ urls: ["https://a.example/x"], question: "what matters" }).success).toBe(true);
    expect(s.safeParse({ urls: [], question: "q?" }).success).toBe(false);
    expect(s.safeParse({ urls: Array(5).fill("https://a.example/x"), question: "q?" }).success).toBe(false);
  });
  test("news.source.add needs one of url, sender, subreddit", () => {
    const s = TOOL_SCHEMAS["news.source.add"];
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ sender: "@tldrnewsletter.com" }).success).toBe(true);
    expect(s.safeParse({ subreddit: "rust" }).success).toBe(true);
    expect(s.safeParse({ url: "https://blog.example.com" }).success).toBe(true);
  });
  test("interest.add accepts a limited time and an avoid flag", () => {
    const s = TOOL_SCHEMAS["interest.add"];
    expect(s.safeParse({ topic: "Rust", days: 14 }).success).toBe(true);
    expect(s.safeParse({ topic: "crypto", avoid: true }).success).toBe(true);
    expect(s.safeParse({ topic: "Rust", days: -1 }).success).toBe(false);
  });
  test("brief.configure takes sections and extra times, rejecting unknown sections", () => {
    const s = TOOL_SCHEMAS["brief.configure"];
    expect(s.safeParse({ sections: ["email", "news"], extraTimes: [{ timeOfDay: "13:00", sections: ["news"] }] }).success).toBe(true);
    expect(s.safeParse({ sections: ["weather"] }).success).toBe(false);
    expect(s.safeParse({ extraTimes: [{ timeOfDay: "1pm", sections: ["news"] }] }).success).toBe(false);
  });
});

describe("digest slots", () => {
  const base: BriefConfig = { enabled: true, timeOfDay: "07:00" };
  test("a config from before sections existed keeps its brief and verse", () => {
    expect(slotsOf(base)).toEqual([{ timeOfDay: "07:00", sections: DEFAULT_SECTIONS }]);
  });
  test("extra times are slots of their own", () => {
    const cfg: BriefConfig = { ...base, extraTimes: [{ timeOfDay: "13:00", sections: ["news"] }] };
    expect(slotsOf(cfg).map((s) => s.timeOfDay)).toEqual(["07:00", "13:00"]);
  });
  test("the next digest is the soonest slot, then wraps to the next day", () => {
    const cfg: BriefConfig = { ...base, extraTimes: [{ timeOfDay: "13:00", sections: ["news"] }] };
    const tz = "Africa/Lagos"; // UTC+1, no DST
    const at = (iso: string) => Date.parse(iso);
    // 08:00 Lagos: 13:00 is next
    expect(nextSlot(cfg, tz, at("2026-11-23T07:00:00Z")).slot.timeOfDay).toBe("13:00");
    // 14:00 Lagos: 07:00 tomorrow is next
    const after = nextSlot(cfg, tz, at("2026-11-23T13:00:00Z"));
    expect(after.slot.timeOfDay).toBe("07:00");
    expect(after.at).toBe(at("2026-11-24T06:00:00Z"));
    // 05:00 Lagos: the morning one is next
    expect(nextSlot(cfg, tz, at("2026-11-23T04:00:00Z")).slot.timeOfDay).toBe("07:00");
  });
});

describe("news outcomes", () => {
  test("a digest with news and an extra time reads back plainly", () => {
    const text = renderOutcomes("", [
      { name: "brief.configure", ok: true, result: { enabled: true, timeOfDay: "07:00", sections: ["email", "news"], extraTimes: [{ timeOfDay: "13:00", sections: ["news"] }] } },
    ], []);
    expect(text).toContain("07:00");
    expect(text).toContain("email, news");
    expect(text).toContain("13:00 (news)");
  });
  test("a temporary interest says until when", () => {
    const text = renderOutcomes("", [{ name: "interest.add", ok: true, result: { topic: "Rust", avoid: false, until: "Mon 30 Nov" } }], []);
    expect(text).toContain("more Rust until Mon 30 Nov");
  });
});
