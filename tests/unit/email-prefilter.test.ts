import { describe, expect, test } from "bun:test";
import { prefilter } from "../../convex/lib/email/prefilter";

describe("prefilter", () => {
  test("a known noise sender never reaches the model", () => {
    const verdict = prefilter({
      isNoiseSender: true,
      labelIds: [],
      hasListUnsubscribe: false,
      projectKeywordHit: false,
    });
    expect(verdict).toEqual({ skip: true, importance: "LOW", reason: "noise_sender" });
  });

  test("bulk mail from a sender who is not HIGH+ is skipped", () => {
    const verdict = prefilter({
      isNoiseSender: false,
      labelIds: [],
      hasListUnsubscribe: true,
      senderImportance: "NORMAL",
      projectKeywordHit: false,
    });
    expect(verdict.skip).toBe(true);
    if (verdict.skip) expect(verdict.reason).toBe("bulk_not_high_plus_sender");
  });

  test("bulk mail from a HIGH+ sender still reaches the model", () => {
    const verdict = prefilter({
      isNoiseSender: false,
      labelIds: [],
      hasListUnsubscribe: true,
      senderImportance: "HIGH",
      projectKeywordHit: false,
    });
    expect(verdict.skip).toBe(false);
  });

  test("promotions with no project hit is skipped", () => {
    const verdict = prefilter({
      isNoiseSender: false,
      labelIds: ["CATEGORY_PROMOTIONS"],
      hasListUnsubscribe: false,
      projectKeywordHit: false,
    });
    expect(verdict).toEqual({ skip: true, importance: "LOW", reason: "promotions_no_project_hit" });
  });

  test("promotions WITH a project keyword hit still reaches the model", () => {
    const verdict = prefilter({
      isNoiseSender: false,
      labelIds: ["CATEGORY_PROMOTIONS"],
      hasListUnsubscribe: false,
      projectKeywordHit: true,
    });
    expect(verdict.skip).toBe(false);
  });

  test("a CRITICAL-importance sender floors to HIGH but is still classified", () => {
    const verdict = prefilter({
      isNoiseSender: false,
      labelIds: [],
      hasListUnsubscribe: false,
      senderImportance: "CRITICAL",
      projectKeywordHit: false,
    });
    expect(verdict).toEqual({ skip: false, floor: "HIGH" });
  });

  test("ordinary mail with no signals reaches the model with no floor", () => {
    const verdict = prefilter({
      isNoiseSender: false,
      labelIds: [],
      hasListUnsubscribe: false,
      projectKeywordHit: false,
    });
    expect(verdict).toEqual({ skip: false });
  });

  test("noise sender wins over every other signal", () => {
    const verdict = prefilter({
      isNoiseSender: true,
      labelIds: ["CATEGORY_PROMOTIONS"],
      hasListUnsubscribe: true,
      senderImportance: "CRITICAL",
      projectKeywordHit: true,
    });
    expect(verdict).toEqual({ skip: true, importance: "LOW", reason: "noise_sender" });
  });
});
