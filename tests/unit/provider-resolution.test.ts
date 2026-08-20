import { describe, expect, test } from "bun:test";
import { resolveProviderChain, NoProviderAvailable } from "../../convex/lib/ai/resolve";

// A fake environment. These tests never touch process.env, never touch the
// network, and never start Convex — resolveProviderChain is a pure function.
const withKeys = (keys: Record<string, string>) => ({
  AI_PROVIDER_PRIORITY: "gemini,openai,anthropic",
  ...keys,
});

describe("resolveProviderChain", () => {
  test("uses only providers whose API key is present", () => {
    const env = withKeys({ OPENAI_API_KEY: "sk-test" });
    expect(resolveProviderChain(env, "REASON")).toEqual(["openai"]);
  });

  test("honours AI_PROVIDER_PRIORITY order", () => {
    const env = withKeys({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
    expect(resolveProviderChain(env, "REASON")).toEqual(["gemini", "openai"]);
  });

  test("a per-task override jumps the queue", () => {
    const env = withKeys({
      GEMINI_API_KEY: "g",
      OPENAI_API_KEY: "o",
      AI_ROUTE_CHAT_REPLY: "openai",
    });
    expect(resolveProviderChain(env, "REASON", "CHAT_REPLY")).toEqual([
      "openai",
      "gemini",
    ]);
  });

  test("skips providers that do not support the tier", () => {
    // Anthropic has no TRANSCRIBE tier.
    const env = withKeys({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" });
    expect(resolveProviderChain(env, "TRANSCRIBE")).toEqual(["gemini"]);
  });

  test("throws a typed error when nothing is configured", () => {
    expect(() => resolveProviderChain({}, "REASON")).toThrow(NoProviderAvailable);
  });
});

describe("resolveProviderChain — openrouter", () => {
  test("openrouter participates in the priority chain like any provider", () => {
    const env = { AI_PROVIDER_PRIORITY: "openrouter,gemini", OPENROUTER_API_KEY: "sk-or-x" };
    expect(resolveProviderChain(env, "REASON")).toEqual(["openrouter"]);
  });
});
