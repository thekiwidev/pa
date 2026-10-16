import { describe, expect, test } from "bun:test";
import { describeRoutes, embedProvider, routeWarnings } from "../../convex/lib/ai/routes";

const both = {
  GEMINI_API_KEY: "g",
  OPENAI_API_KEY: "o",
  AI_PROVIDER_PRIORITY: "openai,gemini",
  GEMINI_MODEL_REASON: "gemini-3.5-flash,gemini-3.6-flash",
  GEMINI_MODEL_VISION: "gemini-3.5-flash",
  GEMINI_MODEL_TRANSCRIBE: "gemini-3.5-flash",
  OPENAI_MODEL_REASON: "gpt-5.4-mini",
};

describe("describeRoutes", () => {
  test("a task goes to the first provider whose model ladder is set", () => {
    const plan = describeRoutes(both).find((r) => r.task === "PLAN_TOOLS")!;
    expect(plan.tier).toBe("REASON");
    expect(plan.providers.map((p) => p.id)).toEqual(["openai", "gemini"]);
    expect(plan.providers[0]!.models).toEqual(["gpt-5.4-mini"]);
  });

  test("a provider with no ladder for the tier is skipped, as runTask skips it", () => {
    // OPENAI_MODEL_VISION is unset, so EXTRACT_POST really runs on Gemini.
    const extract = describeRoutes(both).find((r) => r.task === "EXTRACT_POST")!;
    expect(extract.providers.map((p) => p.id)).toEqual(["gemini"]);
  });

  test("audio and video never route to OpenAI", () => {
    const video = describeRoutes(both).find((r) => r.task === "TRANSCRIBE_VIDEO")!;
    expect(video.providers.map((p) => p.id)).toEqual(["gemini"]);
  });

  test("AI_ROUTE_<TASK> moves its provider to the front", () => {
    const routed = describeRoutes({ ...both, AI_ROUTE_PLAN_TOOLS: "gemini" });
    expect(routed.find((r) => r.task === "PLAN_TOOLS")!.providers[0]!.id).toBe("gemini");
  });

  test("embeddings are reported with the one provider that will embed", () => {
    const embed = describeRoutes(both).find((r) => r.task === "EMBED_TEXT")!;
    expect(embed.providers).toEqual([{ id: "gemini", models: ["gemini-embedding-001"] }]);
  });
});

describe("embedProvider", () => {
  test("Gemini whenever its key is set, even with OpenAI first in priority", () => {
    expect(embedProvider(both)).toBe("gemini");
  });
  test("OpenAI only when it is the sole key, or pinned", () => {
    expect(embedProvider({ OPENAI_API_KEY: "o" })).toBe("openai");
    expect(embedProvider({ ...both, AI_ROUTE_EMBED_TEXT: "openai" })).toBe("openai");
  });
  test("a pin to a provider without a key is ignored", () => {
    expect(embedProvider({ GEMINI_API_KEY: "g", AI_ROUTE_EMBED_TEXT: "openai" })).toBe("gemini");
  });
  test("no key, no embeddings", () => {
    expect(embedProvider({})).toBeNull();
  });
});

describe("routeWarnings", () => {
  test("flags floating Gemini aliases, which follow Google to its newest model", () => {
    const w = routeWarnings({ GEMINI_MODEL_REASON: "gemini-3.5-flash,gemini-flash-latest" });
    expect(w.join("\n")).toContain("GEMINI_MODEL_REASON");
    expect(w.join("\n")).toContain("gemini-flash-latest");
  });
  test("flags a retired model id", () => {
    const w = routeWarnings({ GEMINI_MODEL_DRAFT: "gemini-3.7-flash,gemini-3.5-flash" });
    expect(w.join("\n")).toContain("gemini-3.7-flash");
  });
  test("a clean ladder has no warnings", () => {
    expect(routeWarnings({ GEMINI_MODEL_REASON: "gemini-3.5-flash,gemini-3.6-flash" })).toEqual([]);
  });
});
