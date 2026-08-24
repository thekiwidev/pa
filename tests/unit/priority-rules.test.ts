import { describe, expect, test } from "bun:test";
import { applyPriorityRules, type PriorityRules } from "../../convex/lib/email/priority";
import { parsePriorityRules } from "../../convex/lib/email/priority";

const recruiting: PriorityRules = {
  label: "recruiting",
  floors: [
    { when: { category: "INTERVIEW" }, minImportance: "CRITICAL" },
    { when: { category: "JOB_OPPORTUNITY" }, minImportance: "HIGH" },
  ],
  ceilings: [{ when: { category: "PROMOTION" }, maxImportance: "LOW" }],
  scanSpam: true,
};

const personal: PriorityRules = {
  label: "personal",
  ceilings: [
    { when: { category: "PROMOTION" }, maxImportance: "IGNORE" },
    { when: { category: "NEWSLETTER" }, maxImportance: "LOW" },
  ],
  scanSpam: true,
};

describe("applyPriorityRules", () => {
  test("a floor raises a classifier's rank", () => {
    expect(applyPriorityRules("LOW", "INTERVIEW", recruiting)).toBe("CRITICAL");
    expect(applyPriorityRules("NORMAL", "JOB_OPPORTUNITY", recruiting)).toBe("HIGH");
  });

  test("a floor never LOWERS a rank the classifier already gave", () => {
    expect(applyPriorityRules("CRITICAL", "JOB_OPPORTUNITY", recruiting)).toBe("CRITICAL");
  });

  test("a ceiling caps a classifier's rank", () => {
    expect(applyPriorityRules("HIGH", "PROMOTION", recruiting)).toBe("LOW");
    expect(applyPriorityRules("CRITICAL", "PROMOTION", personal)).toBe("IGNORE");
  });

  test("a ceiling never RAISES a rank the classifier already gave", () => {
    expect(applyPriorityRules("IGNORE", "PROMOTION", personal)).toBe("IGNORE");
  });

  test("an unmatched category passes through unchanged", () => {
    expect(applyPriorityRules("NORMAL", "OTHER", recruiting)).toBe("NORMAL");
    expect(applyPriorityRules("NORMAL", undefined, recruiting)).toBe("NORMAL");
  });

  test("no rules configured is a no-op", () => {
    expect(applyPriorityRules("LOW", "INTERVIEW", undefined)).toBe("LOW");
  });

  test("a rule with no category condition matches every category", () => {
    const catchAll: PriorityRules = {
      label: "test",
      ceilings: [{ when: {}, maxImportance: "NORMAL" }],
    };
    expect(applyPriorityRules("CRITICAL", "ANYTHING", catchAll)).toBe("NORMAL");
  });

  test("a ceiling wins when a category matches both a floor and a ceiling", () => {
    const conflicting: PriorityRules = {
      label: "test",
      floors: [{ when: { category: "X" }, minImportance: "CRITICAL" }],
      ceilings: [{ when: { category: "X" }, maxImportance: "LOW" }],
    };
    expect(applyPriorityRules("NORMAL", "X", conflicting)).toBe("LOW");
  });
});

describe("parsePriorityRules — the column is v.any(), so this is the boundary", () => {
  const valid = {
    label: "recruiting",
    floors: [{ when: { category: "INTERVIEW" }, minImportance: "CRITICAL" }],
    ceilings: [{ when: { category: "PROMOTION" }, maxImportance: "LOW" }],
    scanSpam: true,
  };

  test("accepts the documented shape", () => {
    const parsed = parsePriorityRules(valid);
    expect(parsed?.floors).toHaveLength(1);
    expect(parsed?.ceilings).toHaveLength(1);
    expect(parsed?.scanSpam).toBe(true);
  });

  test("round-trips through apply unchanged", () => {
    expect(applyPriorityRules("NORMAL", "INTERVIEW", parsePriorityRules(valid))).toBe("CRITICAL");
    expect(applyPriorityRules("HIGH", "PROMOTION", parsePriorityRules(valid))).toBe("LOW");
  });

  test.each([
    ["null", null],
    ["a string", "recruiting"],
    ["an array", [{ minImportance: "HIGH" }]],
    ["a number", 3],
    ["an empty object", {}],
  ])("returns undefined for %s", (_label, raw) => {
    expect(parsePriorityRules(raw)).toBeUndefined();
  });

  test("drops a rule whose importance is not a real level", () => {
    // A typo like "URGENT" must not become a rule that silently never fires
    // or, worse, indexes undefined into the rank table.
    const parsed = parsePriorityRules({
      label: "x",
      floors: [{ when: { category: "INTERVIEW" }, minImportance: "URGENT" }],
    });
    expect(parsed).toBeUndefined();
  });

  test("keeps the good rules and drops the malformed ones", () => {
    const parsed = parsePriorityRules({
      label: "x",
      floors: [
        { when: { category: "INTERVIEW" }, minImportance: "CRITICAL" },
        { when: { category: "SPAM" }, minImportance: "NOPE" },
        "not an object",
      ],
    });
    expect(parsed?.floors).toHaveLength(1);
  });

  test("a rule with no `when` matches every category", () => {
    const parsed = parsePriorityRules({
      label: "x",
      floors: [{ minImportance: "HIGH" }],
    });
    expect(applyPriorityRules("LOW", "ANYTHING", parsed)).toBe("HIGH");
  });

  test("malformed rules never crash apply", () => {
    expect(() => applyPriorityRules("NORMAL", "X", parsePriorityRules({ floors: 5 }))).not.toThrow();
  });
});
