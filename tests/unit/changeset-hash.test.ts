import { describe, expect, test } from "bun:test";
import {
  changesetIdFromHash,
  changesetPayloadHash,
  type ChangesetEntry,
} from "../../convex/security/hash";

const change = (over: Partial<ChangesetEntry> = {}): ChangesetEntry => ({
  issueId: "THE-80",
  stateId: "state-done",
  ...over,
});

describe("changesetPayloadHash", () => {
  test("the same batch hashes the same way", async () => {
    expect(await changesetPayloadHash([change()])).toBe(await changesetPayloadHash([change()]));
  });

  test("changing a state changes the hash", async () => {
    expect(await changesetPayloadHash([change()])).not.toBe(
      await changesetPayloadHash([change({ stateId: "state-todo" })]),
    );
  });

  test("changing an issue changes the hash", async () => {
    expect(await changesetPayloadHash([change()])).not.toBe(
      await changesetPayloadHash([change({ issueId: "THE-81" })]),
    );
  });

  test("adding an issue to the batch changes the hash", async () => {
    // The whole point of one approval per BATCH: slipping an extra issue in
    // after the user approved must invalidate the approval.
    expect(await changesetPayloadHash([change()])).not.toBe(
      await changesetPayloadHash([change(), change({ issueId: "THE-81" })]),
    );
  });

  test("order is part of the identity, so a reordered batch re-approves", async () => {
    const a = [change(), change({ issueId: "THE-81" })];
    const b = [change({ issueId: "THE-81" }), change()];
    expect(await changesetPayloadHash(a)).not.toBe(await changesetPayloadHash(b));
  });

  test("a value cannot be smuggled across a field boundary", async () => {
    // Joining on a printable separator would let one field absorb another's
    // content and collide. The separators are control characters precisely
    // so that cannot happen.
    const a = [change({ title: "a", description: "b" })];
    const b = [change({ title: "ab" })];
    expect(await changesetPayloadHash(a)).not.toBe(await changesetPayloadHash(b));
  });

  test("an absent field and an empty one are the same", async () => {
    expect(await changesetPayloadHash([change({ title: undefined })])).toBe(
      await changesetPayloadHash([change({ title: "" })]),
    );
  });
});

describe("changesetIdFromHash", () => {
  test("is a prefix of the full hash", async () => {
    const hash = await changesetPayloadHash([change()]);
    expect(hash.startsWith(changesetIdFromHash(hash))).toBe(true);
  });

  test("fits Telegram's callback_data cap with room for a prefix", async () => {
    // A full SHA-256 hex is 64 chars, which alone exhausts the 64-BYTE limit
    // before any prefix — that is why the id is shortened at all.
    const id = changesetIdFromHash(await changesetPayloadHash([change()]));
    expect(`applyset:${id}`.length).toBeLessThan(64);
  });

  test("different batches get different ids", async () => {
    const a = changesetIdFromHash(await changesetPayloadHash([change()]));
    const b = changesetIdFromHash(await changesetPayloadHash([change({ issueId: "THE-81" })]));
    expect(a).not.toBe(b);
  });
});
