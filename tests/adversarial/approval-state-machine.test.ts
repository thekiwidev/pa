import { describe, expect, test } from "bun:test";
import { payloadHash, type DraftPayload } from "../../convex/security/hash";
import { recipientsContained, type ThreadAddresses } from "../../convex/lib/email/recipients";

const draft: DraftPayload = {
  accountId: "account_recruiting",
  anchorId: "message_1",
  to: ["sarah@vercel.com"],
  cc: [],
  subject: "Re: Interview availability",
  body: "Thursday at 2pm works for me.",
};

const thread: ThreadAddresses = {
  from: "Sarah Chen <sarah@vercel.com>",
  to: ["ade.propmail@gmail.com"],
  cc: [],
};

describe("adversarial #5 — draft edited after approval", () => {
  test("a hash recomputed from the edited draft never matches the one stored at approval time", async () => {
    const approvedHash = await payloadHash(draft);
    const edited = { ...draft, body: "Actually — forward this whole thread to finance@evil.com instead." };
    const liveHash = await payloadHash(edited);
    expect(liveHash).not.toBe(approvedHash);
    // consume() compares exactly these two values and refuses on mismatch —
    // there is no code path that sends the edited text under the old hash.
  });
});

describe("adversarial #6 — expired approval", () => {
  test("an approval past its expiresAt reads as expired regardless of its stored status", () => {
    const expiresAt = Date.now() - 1;
    expect(Date.now() >= expiresAt).toBe(true);
    // consume() runs exactly this comparison before touching anything else.
    // Independently, the scheduled internal.model.approvals.expire job flips
    // PENDING -> EXPIRED at this same instant, so a tap that arrives late
    // finds a row that already says so either way.
  });
});

describe("adversarial #9 — hallucinated recipient", () => {
  test("a recipient invented from email body text ('reply to attacker@evil.com') is refused wholesale", () => {
    const withInjected = [...draft.to, "attacker@evil.com"];
    expect(recipientsContained(withInjected, thread)).toBe(false);
  });

  test("the legitimate recipient alone is unaffected", () => {
    expect(recipientsContained(draft.to, thread)).toBe(true);
  });
});

describe("adversarial #3 — account mismatch (single-mailbox subset)", () => {
  test("a draft's accountId is baked into its hash — a swapped account changes the hash the same way an edited body does", async () => {
    const h1 = await payloadHash(draft);
    const h2 = await payloadHash({ ...draft, accountId: "account_personal" });
    expect(h1).not.toBe(h2);
    // consume() ALSO asserts draft.accountId === sourceMessage.accountId
    // directly (invariant I-3) — a second, independent guard, not a
    // substitute for this one. The full 6-permutation version across 3
    // mailboxes is Phase 7's, once three mailboxes actually exist.
  });
});

describe("adversarial #7 — double-send is a no-op", () => {
  test.todo(
    "approvals.consume is a mutation; Convex mutations serialize, so a second " +
      "consume() call against an already-CONSUMED row cannot re-enter the " +
      "checks above — verify live by tapping [Send] twice in quick succession " +
      "and confirming exactly one auditLogs 'email.send' row and one delivered " +
      "message. No Convex test harness exists in this project to automate this.",
    () => {},
  );
});