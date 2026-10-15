import { describe, expect, test } from "bun:test";
import {
  parsePushEnvelope,
  decodeJwt,
  checkJwtClaims,
} from "../../convex/lib/email/pubsub";

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const b64url = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url");

const envelope = (payload: unknown) => ({
  message: { data: b64(JSON.stringify(payload)), messageId: "1" },
  subscription: "projects/p/subscriptions/s",
});

describe("parsePushEnvelope", () => {
  test("pulls the mailbox and cursor out of a real-shaped push", () => {
    expect(
      parsePushEnvelope(envelope({ emailAddress: "me@gmail.com", historyId: 12345 })),
    ).toEqual({ emailAddress: "me@gmail.com", historyId: "12345" });
  });

  test("a numeric historyId comes back as a string", () => {
    // Gmail sends a NUMBER here and requires a STRING on the history
    // endpoint. Normalising in one place means no caller has to know.
    const parsed = parsePushEnvelope(envelope({ emailAddress: "a@b.com", historyId: 9 }));
    expect(parsed?.historyId).toBe("9");
    expect(typeof parsed?.historyId).toBe("string");
  });

  test("a string historyId is left alone", () => {
    expect(
      parsePushEnvelope(envelope({ emailAddress: "a@b.com", historyId: "77" }))?.historyId,
    ).toBe("77");
  });

  test("base64url encoding is accepted, not just base64", () => {
    const payload = JSON.stringify({ emailAddress: "a+b@x.com", historyId: 1 });
    const body = { message: { data: Buffer.from(payload).toString("base64url") } };
    expect(parsePushEnvelope(body)?.emailAddress).toBe("a+b@x.com");
  });

  test("every malformed shape returns null rather than throwing", () => {
    // A push that cannot be parsed must be ACKed and dropped. Throwing makes
    // Pub/Sub redeliver it forever.
    for (const body of [
      null,
      undefined,
      "string",
      42,
      {},
      { message: null },
      { message: {} },
      { message: { data: "" } },
      { message: { data: "!!!not base64!!!" } },
      { message: { data: b64("not json") } },
      { message: { data: b64('"a string"') } },
      { message: { data: b64("{}") } },
      { message: { data: b64(JSON.stringify({ emailAddress: "a@b.com" })) } },
      { message: { data: b64(JSON.stringify({ historyId: 1 })) } },
      { message: { data: b64(JSON.stringify({ emailAddress: "", historyId: 1 })) } },
    ]) {
      expect(parsePushEnvelope(body)).toBe(null);
    }
  });

  test("carries no message content — only which mailbox changed", () => {
    const parsed = parsePushEnvelope(
      envelope({ emailAddress: "a@b.com", historyId: 1, subject: "evil", body: "evil" }),
    );
    expect(Object.keys(parsed!).sort()).toEqual(["emailAddress", "historyId"]);
  });
});

describe("decodeJwt", () => {
  const make = (header: unknown, payload: unknown, sig = "AQAB") =>
    `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${sig}`;

  test("splits a well-formed token", () => {
    const token = make({ alg: "RS256", kid: "k1" }, { aud: "x" });
    const decoded = decodeJwt(token);
    expect(decoded?.header).toEqual({ alg: "RS256", kid: "k1" });
    expect(decoded?.payload).toEqual({ aud: "x" });
    expect(decoded?.signingInput).toBe(token.split(".").slice(0, 2).join("."));
  });

  test("the signing input is exactly the first two segments", () => {
    // Getting this wrong makes every signature check fail, or worse, pass
    // over the wrong bytes.
    const token = make({ alg: "RS256" }, { sub: "1" });
    const parts = token.split(".");
    expect(decodeJwt(token)!.signingInput).toBe(`${parts[0]}.${parts[1]}`);
  });

  test("malformed tokens are null, not exceptions", () => {
    for (const token of ["", "a", "a.b", "a.b.c.d", "!!.!!.!!", `${b64url("nope")}.x.y`]) {
      expect(decodeJwt(token)).toBe(null);
    }
  });
});

describe("checkJwtClaims", () => {
  const NOW = Date.parse("2026-09-06T12:00:00Z");
  const nowSec = Math.floor(NOW / 1000);
  const expect_ = {
    audience: "https://x.convex.site/webhooks/gmail",
    serviceAccountEmail: "pusher@project.iam.gserviceaccount.com",
    nowMs: NOW,
  };
  const good = {
    iss: "https://accounts.google.com",
    aud: expect_.audience,
    email: expect_.serviceAccountEmail,
    email_verified: true,
    iat: nowSec - 10,
    exp: nowSec + 3600,
  };

  test("a genuine token passes", () => {
    expect(checkJwtClaims(good, expect_)).toEqual({ ok: true });
  });

  test("both accepted issuer spellings work", () => {
    expect(checkJwtClaims({ ...good, iss: "accounts.google.com" }, expect_).ok).toBe(true);
  });

  test("a token for a different audience is refused", () => {
    // Without this, a token minted for any other Google service would pass.
    const result = checkJwtClaims({ ...good, aud: "https://evil.example" }, expect_);
    expect(result).toEqual({ ok: false, reason: "audience mismatch" });
  });

  test("a token from a different service account is refused", () => {
    const result = checkJwtClaims({ ...good, email: "someone@else.com" }, expect_);
    expect(result.ok).toBe(false);
  });

  test("an unverified email is refused", () => {
    expect(checkJwtClaims({ ...good, email_verified: false }, expect_).ok).toBe(false);
  });

  test("a wrong issuer is refused", () => {
    expect(checkJwtClaims({ ...good, iss: "https://evil.example" }, expect_).ok).toBe(false);
  });

  test("an expired token is refused", () => {
    expect(checkJwtClaims({ ...good, exp: nowSec - 3600 }, expect_).ok).toBe(false);
  });

  test("a token with no expiry at all is refused", () => {
    const { exp: _exp, ...noExp } = good;
    expect(checkJwtClaims(noExp, expect_)).toEqual({ ok: false, reason: "no expiry" });
  });

  test("a token issued in the future is refused", () => {
    expect(checkJwtClaims({ ...good, iat: nowSec + 600 }, expect_).ok).toBe(false);
  });

  test("small clock skew is tolerated in both directions", () => {
    // Google's clock and this deployment's are not the same clock.
    expect(checkJwtClaims({ ...good, exp: nowSec - 30 }, expect_).ok).toBe(true);
    expect(checkJwtClaims({ ...good, iat: nowSec + 30 }, expect_).ok).toBe(true);
  });

  test("every rejection says why", () => {
    const result = checkJwtClaims({ ...good, aud: "wrong" }, expect_);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  test("an empty payload is refused, not defaulted", () => {
    expect(checkJwtClaims({}, expect_).ok).toBe(false);
  });
});
