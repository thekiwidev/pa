import { describe, expect, test } from "bun:test";
import { isQuotaExhausted } from "../../convex/lib/ai/errors";

describe("isQuotaExhausted", () => {
  test("recognises OpenAI's 429 body", () => {
    expect(
      isQuotaExhausted(
        '{"error":{"message":"You have no credits remaining.","type":"insufficient_quota"}}',
      ),
    ).toBe(true);
  });

  test("recognises Anthropic's 400 body", () => {
    expect(
      isQuotaExhausted(
        '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
      ),
    ).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isQuotaExhausted("INSUFFICIENT_QUOTA")).toBe(true);
  });

  test("does NOT swallow a malformed-request bug", () => {
    expect(
      isQuotaExhausted('{"error":{"message":"Request contains an invalid argument."}}'),
    ).toBe(false);
  });

  test("does NOT swallow an auth failure", () => {
    expect(isQuotaExhausted('{"error":{"message":"invalid x-api-key"}}')).toBe(false);
  });
});

describe("isQuotaExhausted — Gemini free tier", () => {
  test("recognises a Gemini RESOURCE_EXHAUSTED body", () => {
    expect(
      isQuotaExhausted(
        'gemini returned 429: {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
      ),
    ).toBe(true);
  });

  test("classifies an aggregated multi-model failure line", () => {
    // This is the shape runTask accumulates, and what AllProvidersFailed
    // inspects to decide whether to apologise or to report a bug.
    expect(
      isQuotaExhausted(
        "gemini/gemini-3.7-flash: gemini returned 429: RESOURCE_EXHAUSTED",
      ),
    ).toBe(true);
  });

  test("a missing-model failure is NOT a quota problem", () => {
    expect(
      isQuotaExhausted("gemini/typo-model: gemini 404: model not found"),
    ).toBe(false);
  });
});
