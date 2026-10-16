import { describe, expect, test } from "bun:test";
import { mergeForProd, parseEnv } from "../../scripts/env-merge";

const dev = parseEnv(`ENCRYPTION_KEY=devkey
TELEGRAM_BOT_TOKEN=devbot
TELEGRAM_WEBHOOK_SECRET=devsecret
GOOGLE_REDIRECT_URI=https://coordinated-owl-164.convex.site/oauth/google/callback
GOOGLE_PUBSUB_TOPIC=projects/p/topics/gmail-push-dev
GOOGLE_PUBSUB_AUDIENCE=https://coordinated-owl-164.convex.site/webhooks/gmail
GEMINI_MODEL_REASON=gemini-3.5-flash,gemini-3.6-flash
NOTION_LISTS={"movies":"abc"}
OPENAI_API_KEY=sk-shared`);

const prodLive = parseEnv(`ENCRYPTION_KEY=prodkey
TELEGRAM_BOT_TOKEN=prodbot
TELEGRAM_WEBHOOK_SECRET=prodsecret
GOOGLE_REDIRECT_URI=https://wonderful-fish-292.convex.site/oauth/google/callback
GOOGLE_PUBSUB_TOPIC=projects/p/topics/gmail-push-prod
GOOGLE_PUBSUB_AUDIENCE=https://wonderful-fish-292.convex.site/webhooks/gmail
GEMINI_MODEL_REASON=gemini-3.7-flash,gemini-flash-latest
PROD_ONLY_THING=x`);

describe("mergeForProd", () => {
  const r = mergeForProd(dev, prodLive, new Map());
  const out = parseEnv(r.lines.join("\n"));

  test("prod keeps its own secrets and URLs", () => {
    expect(out.get("ENCRYPTION_KEY")!.value).toBe("prodkey");
    expect(out.get("TELEGRAM_BOT_TOKEN")!.value).toBe("prodbot");
    expect(out.get("GOOGLE_PUBSUB_TOPIC")!.value).toContain("gmail-push-prod");
  });
  test("shared settings come from dev, replacing prod's stale ones", () => {
    expect(out.get("GEMINI_MODEL_REASON")!.value).toBe("gemini-3.5-flash,gemini-3.6-flash");
    expect(out.get("OPENAI_API_KEY")!.value).toBe("sk-shared");
    expect(out.get("NOTION_LISTS")!.value).toBe('{"movies":"abc"}');
  });
  test("variables only on prod survive", () => {
    expect(out.get("PROD_ONLY_THING")!.value).toBe("x");
  });
  test("a clean merge has no problems", () => {
    expect(r.problems).toEqual([]);
  });
  test("falls back to the old .env.prod when the deployment lacks a secret", () => {
    const live = new Map(prodLive);
    live.delete("ENCRYPTION_KEY");
    const r2 = mergeForProd(dev, live, parseEnv("ENCRYPTION_KEY=fromfile"));
    expect(parseEnv(r2.lines.join("\n")).get("ENCRYPTION_KEY")!.value).toBe("fromfile");
  });
  test("blocks a missing prod secret, a dev-equal secret, and a dev URL", () => {
    const live = new Map(prodLive);
    live.delete("TELEGRAM_BOT_TOKEN");
    live.set("ENCRYPTION_KEY", { name: "ENCRYPTION_KEY", value: "devkey", raw: "ENCRYPTION_KEY=devkey" });
    live.set("GOOGLE_REDIRECT_URI", dev.get("GOOGLE_REDIRECT_URI")!);
    const p = mergeForProd(dev, live, new Map()).problems.join("\n");
    expect(p).toContain("TELEGRAM_BOT_TOKEN: no prod value");
    expect(p).toContain("ENCRYPTION_KEY: prod value is the same as dev");
    expect(p).toContain("GOOGLE_REDIRECT_URI: value points at dev");
  });
  test("problems name variables, never values", () => {
    const live = new Map(prodLive);
    live.set("ENCRYPTION_KEY", { name: "ENCRYPTION_KEY", value: "devkey", raw: "" });
    expect(mergeForProd(dev, live, new Map()).problems.join("\n")).not.toContain("devkey");
  });
});

describe("parseEnv", () => {
  test("strips matching quotes and keeps = inside values", () => {
    const e = parseEnv(`A="x=y"\nB='z'\n# comment\nC=plain`);
    expect(e.get("A")!.value).toBe("x=y");
    expect(e.get("B")!.value).toBe("z");
    expect(e.get("C")!.value).toBe("plain");
  });
});
