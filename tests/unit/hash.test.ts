import { describe, expect, test } from "bun:test";
import { payloadHash, type DraftPayload } from "../../convex/security/hash";

const base: DraftPayload = {
  accountId: "account_recruiting",
  anchorId: "message_1",
  to: ["sarah@vercel.com"],
  cc: [],
  subject: "Re: Interview availability",
  body: "Thursday at 2pm works for me.",
};

describe("payloadHash", () => {
  test("is deterministic for identical input", async () => {
    expect(await payloadHash(base)).toBe(await payloadHash({ ...base }));
  });

  test("changes when the body changes — the edited-after-approval case", async () => {
    const h1 = await payloadHash(base);
    const h2 = await payloadHash({ ...base, body: "Friday at 2pm works instead." });
    expect(h1).not.toBe(h2);
  });

  test("changes when a recipient is added", async () => {
    const h1 = await payloadHash(base);
    const h2 = await payloadHash({ ...base, to: [...base.to, "extra@vercel.com"] });
    expect(h1).not.toBe(h2);
  });

  test("changes when the account differs — invariant I-3 baked into the hash itself", async () => {
    const h1 = await payloadHash(base);
    const h2 = await payloadHash({ ...base, accountId: "account_personal" });
    expect(h1).not.toBe(h2);
  });

  test("changes when an attachment is swapped in — closes adversarial #10 ahead of Phase 11", async () => {
    const h1 = await payloadHash(base);
    const h2 = await payloadHash({ ...base, attachmentFileIds: ["file_123"] });
    expect(h1).not.toBe(h2);
  });

  test("is a 64-character lowercase hex string", async () => {
    expect(await payloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
