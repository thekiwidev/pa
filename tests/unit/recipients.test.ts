import { describe, expect, test } from "bun:test";
import {
  recipientsContained,
  threadAddressSet,
  type ThreadAddresses,
} from "../../convex/lib/email/recipients";

const thread: ThreadAddresses = {
  from: "Sarah Chen <sarah@vercel.com>",
  to: ["ade.propmail@gmail.com"],
  cc: ["hiring@vercel.com"],
  replyTo: "recruiting@vercel.com",
};

describe("recipientsContained", () => {
  test("passes when every recipient is in the thread's own address set", () => {
    expect(recipientsContained(["sarah@vercel.com"], thread)).toBe(true);
    expect(recipientsContained(["hiring@vercel.com", "sarah@vercel.com"], thread)).toBe(true);
  });

  test("passes for the thread's Reply-To address", () => {
    expect(recipientsContained(["recruiting@vercel.com"], thread)).toBe(true);
  });

  test("refuses a hallucinated or injected address wholesale — no partial send", () => {
    expect(recipientsContained(["sarah@vercel.com", "attacker@evil.com"], thread)).toBe(false);
  });

  test("is case-insensitive and ignores display names", () => {
    expect(recipientsContained(['"Sarah" <SARAH@VERCEL.COM>'], thread)).toBe(true);
  });

  test("an empty recipient list trivially passes — nothing to check", () => {
    expect(recipientsContained([], thread)).toBe(true);
  });
});

describe("threadAddressSet", () => {
  test("omits an absent replyTo rather than inserting undefined", () => {
    const set = threadAddressSet({ from: "a@x.com", to: [], cc: [] });
    expect(set.has("undefined")).toBe(false);
    expect(set.size).toBe(1);
  });
});
