import { describe, expect, test } from "bun:test";
import {
  EMAIL_IMPORTANCE_CATEGORY,
  categoryCriterion,
  splitOwnerContext,
} from "../../convex/lib/email/importance";
import { CONTEXT_CATEGORIES, normalizeCategory } from "../../convex/lib/userContext";

describe("email_importance category", () => {
  test("is a real userContext category, not filed under other", () => {
    expect((CONTEXT_CATEGORIES as readonly string[]).includes(EMAIL_IMPORTANCE_CATEGORY)).toBe(true);
    expect(normalizeCategory("email importance")).toBe("email_importance");
    expect(normalizeCategory("Email-Importance")).toBe("email_importance");
  });
});

describe("splitOwnerContext", () => {
  test("separates criteria from facts", () => {
    const out = splitOwnerContext([
      { category: "profile", text: "Frontend engineer" },
      { category: "email_importance", text: "alert me: invoices from clients" },
      { category: "preferences", text: "Terse replies" },
    ]);
    expect(out.facts).toEqual(["Frontend engineer", "Terse replies"]);
    expect(out.criteria).toEqual(["alert me: invoices from clients"]);
  });
});

describe("categoryCriterion", () => {
  test("is drafted from the category, never from email text", () => {
    expect(categoryCriterion("SECURITY_ALERT")).toBe("never alert: routine security and sign-in notices");
    expect(categoryCriterion("PROMOTION")).toBe("never alert: promotions");
    expect(categoryCriterion("NEWSLETTER")).toBe("never alert: newsletters");
  });
  test("categories too broad to silence give nothing", () => {
    expect(categoryCriterion("OTHER")).toBeNull();
    expect(categoryCriterion("INTERVIEW")).toBeNull();
    expect(categoryCriterion(undefined)).toBeNull();
    expect(categoryCriterion("PHISHING_SUSPECTED")).toBeNull();
  });
});
