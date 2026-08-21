import { describe, expect, test } from "bun:test";
import {
  ImportanceSchema,
  buildClassificationInput,
  parseClassifierResponse,
  isSpamCredentialPhish,
  applyOverrides,
  applyFloor,
  CLASSIFIER_VERSION,
  type Importance,
} from "../../convex/lib/email/classification";

const validPayload: Importance = {
  importance: "HIGH",
  confidence: 0.8,
  whyItMatters: "Recruiter following up.",
  category: "JOB_OPPORTUNITY",
  deadlineMentioned: null,
  requestedOfYou: "Availability this week",
  suggestedAction: "REPLY",
  projectHint: null,
};

describe("ImportanceSchema", () => {
  test("accepts a well-formed classification", () => {
    expect(ImportanceSchema.parse(validPayload)).toEqual(validPayload);
  });

  test("has no field capable of expressing an action", () => {
    const keys = Object.keys(ImportanceSchema.shape);
    for (const forbidden of ["to", "cc", "body", "send", "recipient", "action", "tool", "toolCall"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test("rejects an out-of-range confidence", () => {
    expect(ImportanceSchema.safeParse({ ...validPayload, confidence: 1.5 }).success).toBe(false);
  });

  test("rejects an unknown importance value", () => {
    expect(ImportanceSchema.safeParse({ ...validPayload, importance: "URGENT" }).success).toBe(false);
  });

  test("strips a smuggled field instead of executing it", () => {
    const withExtra = { ...validPayload, sendTo: "attacker@evil.com", executeNow: true };
    const parsed = ImportanceSchema.parse(withExtra);
    expect(parsed).not.toHaveProperty("sendTo");
    expect(parsed).not.toHaveProperty("executeNow");
  });
});

describe("buildClassificationInput", () => {
  test("never inlines the email body — only the trusted facts", () => {
    const input = buildClassificationInput({
      fromAddress: "s.chen@vercel.com",
      subject: "Interview availability",
      isInSpam: false,
      senderImportance: "HIGH",
      knownProjects: ["Momentum Logistics"],
    });
    expect(input).toContain("s.chen@vercel.com");
    expect(input).toContain("Momentum Logistics");
    expect(input).not.toContain("ignore previous instructions");
  });
});

describe("parseClassifierResponse", () => {
  test("parses a clean JSON response", () => {
    const result = parseClassifierResponse(JSON.stringify(validPayload));
    expect(result.ok).toBe(true);
    expect(result.value?.importance).toBe("HIGH");
  });

  test("parses a response wrapped in a markdown code fence", () => {
    const result = parseClassifierResponse("```json\n" + JSON.stringify(validPayload) + "\n```");
    expect(result.ok).toBe(true);
  });

  test("reports, not throws, on invalid JSON", () => {
    const result = parseClassifierResponse("not json at all");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("reports, not throws, when the shape is wrong", () => {
    const result = parseClassifierResponse(JSON.stringify({ importance: "HIGH" }));
    expect(result.ok).toBe(false);
  });
});

describe("isSpamCredentialPhish / applyOverrides", () => {
  const phishingFacts = {
    labelIds: ["SPAM"],
    dmarc: "fail",
    subject: "Your account has been suspended",
    bodyText: "Click here to verify your identity immediately.",
  };

  test("SPAM + DMARC fail + credential language is flagged", () => {
    expect(isSpamCredentialPhish(phishingFacts)).toBe(true);
  });

  test("SPAM + DMARC pass is NOT flagged, even with the same language", () => {
    expect(isSpamCredentialPhish({ ...phishingFacts, dmarc: "pass" })).toBe(false);
  });

  test("DMARC fail outside SPAM is NOT flagged", () => {
    expect(isSpamCredentialPhish({ ...phishingFacts, labelIds: [] })).toBe(false);
  });

  test("SPAM + DMARC fail with no credential language is NOT flagged", () => {
    expect(
      isSpamCredentialPhish({
        ...phishingFacts,
        subject: "Weekly newsletter",
        bodyText: "Here's what's new.",
      }),
    ).toBe(false);
  });

  test("the override forces IGNORE regardless of what the model said", () => {
    const modelSaidCritical: Importance = { ...validPayload, importance: "CRITICAL" };
    const overridden = applyOverrides(modelSaidCritical, phishingFacts);
    expect(overridden.importance).toBe("IGNORE");
  });
});

describe("applyFloor", () => {
  test("raises LOW to HIGH", () => {
    expect(applyFloor({ ...validPayload, importance: "LOW" }, "HIGH").importance).toBe("HIGH");
  });

  test("never lowers CRITICAL to HIGH", () => {
    expect(applyFloor({ ...validPayload, importance: "CRITICAL" }, "HIGH").importance).toBe("CRITICAL");
  });
});

test("classifierVersion is stamped so a re-run is comparable", () => {
  expect(CLASSIFIER_VERSION).toBe("v1");
});
