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

describe("prefilter — user-taught rules outrank every heuristic", () => {
  const base = {
    isNoiseSender: false,
    labelIds: ["INBOX"],
    hasListUnsubscribe: false,
    projectKeywordHit: false,
  };

  test("an IGNORE rule skips the model", () => {
    const v = prefilter({ ...base, userRule: { action: "IGNORE", senderPattern: "@x.com" } });
    expect(v).toEqual({ skip: true, importance: "LOW", reason: "user_rule" });
  });

  test("a FLOOR_HIGH rule still classifies, with a floor", () => {
    const v = prefilter({ ...base, userRule: { action: "FLOOR_HIGH", senderPattern: "@x.com" } });
    expect(v).toEqual({ skip: false, floor: "HIGH" });
  });

  test("a NEVER_ALERT rule classifies but suppresses the alert", () => {
    const v = prefilter({ ...base, userRule: { action: "NEVER_ALERT", senderPattern: "@x.com" } });
    expect(v).toEqual({ skip: false, neverAlert: true });
  });

  test("FLOOR_HIGH rescues a message the bulk heuristic would have buried", () => {
    // The user said this sender matters. A List-Unsubscribe header is an
    // inference; their instruction is not, and must win.
    const v = prefilter({
      ...base,
      hasListUnsubscribe: true,
      userRule: { action: "FLOOR_HIGH", senderPattern: "@newsletter.com" },
    });
    expect(v).toEqual({ skip: false, floor: "HIGH" });
  });

  test("FLOOR_HIGH rescues a message the promotions heuristic would have buried", () => {
    const v = prefilter({
      ...base,
      labelIds: ["CATEGORY_PROMOTIONS"],
      userRule: { action: "FLOOR_HIGH", senderPattern: "@shop.com" },
    });
    expect(v).toEqual({ skip: false, floor: "HIGH" });
  });

  test("an IGNORE rule beats a CRITICAL sender — the user changed their mind", () => {
    const v = prefilter({
      ...base,
      senderImportance: "CRITICAL",
      userRule: { action: "IGNORE", senderPattern: "@x.com" },
    });
    expect(v.skip).toBe(true);
  });

  test("no rule leaves the existing tree untouched", () => {
    expect(prefilter({ ...base, userRule: null })).toEqual({ skip: false });
    expect(prefilter({ ...base, isNoiseSender: true, userRule: null }).skip).toBe(true);
  });
});
