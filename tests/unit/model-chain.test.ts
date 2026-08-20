import { describe, expect, test } from "bun:test";
import { modelChain, modelEnvVar } from "../../convex/lib/ai/tiers";

describe("modelEnvVar", () => {
  test("builds the variable name from provider and tier", () => {
    expect(modelEnvVar("gemini", "REASON")).toBe("GEMINI_MODEL_REASON");
  });
});

describe("modelChain", () => {
  test("splits a comma-separated fallback chain in order", () => {
    const env = { GEMINI_MODEL_REASON: "gemini-3.6-flash,gemini-3.5-flash" };
    expect(modelChain("gemini", "REASON", env)).toEqual([
      "gemini-3.6-flash",
      "gemini-3.5-flash",
    ]);
  });

  test("tolerates whitespace and trailing commas", () => {
    const env = { GEMINI_MODEL_DRAFT: " a , b ,, " };
    expect(modelChain("gemini", "DRAFT", env)).toEqual(["a", "b"]);
  });

  test("a single model is a chain of one", () => {
    expect(modelChain("gemini", "DRAFT", { GEMINI_MODEL_DRAFT: "solo" })).toEqual(["solo"]);
  });

  test("unset returns empty — the registry reports this as a config gap", () => {
    expect(modelChain("gemini", "EMBED", {})).toEqual([]);
  });
});
