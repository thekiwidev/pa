// Tests for the 2026-10-17 alert fix: why important mail never paged the
// phone, the Hark-style card with checked links, and the next-step buttons.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { looksTransactional, prefilter } from "../../convex/lib/email/prefilter";
import {
  describeLinksForClassifier,
  extractLinks,
  isTrustedLink,
  registrableDomain,
  renderSummaryHtml,
  summaryAsPlainText,
} from "../../convex/lib/email/links";
import { composeCard, cardAsHistory, type CardEmail } from "../../convex/notify";
import { normalizeMessage } from "../../convex/connectors/gmail/normalize";
import { parseToolPlan } from "../../convex/lib/tools/plan";
import { TELEGRAM_FORMAT_CONTRACT } from "../../convex/lib/prompts/format";

const PASS = { spf: "pass", dkim: "pass", dmarc: "pass" };

describe("the push sync alerts, like the poll does", () => {
  // The root cause, pinned: syncFromHistory stored new mail and handed it to
  // classifyBacklog, which never alerts. Once stored, the poll saw
  // created=false and skipped it too. Both paths must go through ingestFresh.
  const source = readFileSync(new URL("../../convex/gmail.ts", import.meta.url), "utf8");
  const body = (name: string) => {
    const start = source.indexOf(`export const ${name} =`);
    const end = source.indexOf("\nexport const ", start + 1);
    return source.slice(start, end === -1 ? undefined : end);
  };

  test("syncFromHistory delivers through ingestFresh", () => {
    expect(body("syncFromHistory")).toContain("ingestFresh(");
    expect(body("syncFromHistory")).not.toContain("internal.gmail.classifyBacklog");
  });

  test("syncAccount delivers through ingestFresh", () => {
    expect(body("syncAccount")).toContain("ingestFresh(");
  });
});

describe("bulk-sender mail about the owner reaches the classifier", () => {
  const bulk = {
    isNoiseSender: false,
    labelIds: ["INBOX", "CATEGORY_UPDATES"],
    hasListUnsubscribe: true,
    projectKeywordHit: false,
  };

  test.each([
    ["[thekiwidev/caseforge] Run failed: CI - feat/backlog", ""],
    ["Your YouTube Premium payment didn't go through", "We couldn't charge your billing method"],
    ["New login to Linear", "A new login to your account was detected"],
    ["Your API key is being used for more than heartbeats", "switch to OAuth"],
    ["Payout update", "Your payout is delayed due to a server outage"],
    ["Refund approved for invoice MLS-INV-7B6353-2026", ""],
    ["A third-party OAuth application has been added to your account", "authorized"],
  ])("%s", (subject, text) => {
    const transactionalHint = looksTransactional(subject, text);
    expect(transactionalHint).toBe(true);
    expect(prefilter({ ...bulk, transactionalHint }).skip).toBe(false);
  });

  test("a plain newsletter is still skipped without a model call", () => {
    const transactionalHint = looksTransactional("This week in Bun", "Five new features");
    expect(transactionalHint).toBe(false);
    const verdict = prefilter({ ...bulk, transactionalHint });
    expect(verdict.skip).toBe(true);
  });

  test("the owner's own sent mail never reaches the classifier", () => {
    const verdict = prefilter({ ...bulk, hasListUnsubscribe: false, labelIds: ["SENT"] });
    expect(verdict).toEqual({ skip: true, importance: "LOW", reason: "own_message" });
  });
});

describe("links in alerts", () => {
  const youtube = { fromAddress: "no-reply@youtube.com", labelIds: ["INBOX"], authResults: PASS };

  test("registrable domain handles two-label suffixes", () => {
    expect(registrableDomain("mail.notifications.github.com")).toBe("github.com");
    expect(registrableDomain("shop.example.com.ng")).toBe("example.com.ng");
  });

  test("a link on the sender's own (or same-company) domain is trusted", () => {
    expect(isTrustedLink("https://www.youtube.com/paid_memberships", youtube)).toBe(true);
    expect(
      isTrustedLink("https://www.youtube.com/paid_memberships", {
        ...youtube,
        fromAddress: "payments-noreply@google.com",
      }),
    ).toBe(true);
  });

  test("anything doubtful is not", () => {
    expect(isTrustedLink("https://youtube.com.billing-fix.io/x", youtube)).toBe(false);
    expect(isTrustedLink("http://www.youtube.com/paid_memberships", youtube)).toBe(false);
    expect(isTrustedLink("https://youtube.com@evil.io/", youtube)).toBe(false);
    expect(isTrustedLink("https://www.youtube.com/x", { ...youtube, labelIds: ["SPAM"] })).toBe(false);
    expect(
      isTrustedLink("https://www.youtube.com/x", { ...youtube, authResults: { ...PASS, dmarc: "fail" } }),
    ).toBe(false);
    expect(isTrustedLink("https://www.youtube.com/x", { ...youtube, authResults: undefined })).toBe(false);
  });

  test("a trusted [label](url) becomes a tappable link", () => {
    const html = renderSummaryHtml(
      "Update it at [youtube.com/paid_memberships](https://www.youtube.com/paid_memberships) rather than through the email.",
      youtube,
    );
    expect(html).toContain('<a href="https://www.youtube.com/paid_memberships">youtube.com/paid_memberships</a>');
  });

  test("an untrusted link shows where it goes but cannot be tapped", () => {
    const html = renderSummaryHtml(
      "Finish setup [here](https://staging-7f.hitouch-app.xyz/setup). Looks odd.",
      { fromAddress: "hello@hitouchglobal.com", labelIds: ["INBOX"], authResults: PASS },
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("here (<code>staging-7f.hitouch-app.xyz</code>)");
  });

  test("a bare doubtful address is wrapped so Telegram cannot autolink it", () => {
    const html = renderSummaryHtml("It points to odd-staging.example.io/login.", {
      fromAddress: "hello@hitouchglobal.com",
      labelIds: [],
      authResults: PASS,
    });
    expect(html).toContain("<code>odd-staging.example.io/login</code>");
  });

  test("prose is escaped and words like Node.js are left alone", () => {
    const html = renderSummaryHtml("Your <b>Node.js</b> build & tests failed.", youtube);
    expect(html).toBe("Your &lt;b&gt;Node.js&lt;/b&gt; build &amp; tests failed.");
  });

  test("plain text keeps the label and the address", () => {
    expect(summaryAsPlainText("Fix it at [Billing](https://youtube.com/b).")).toBe(
      "Fix it at Billing (https://youtube.com/b).",
    );
  });

  test("links come out of the HTML part, with their text", () => {
    const links = extractLinks(
      ['<p>Hi</p><a class="btn" href="https://www.youtube.com/paid_memberships?a=1&amp;b=2"><b>Update</b> payment</a> <a href="mailto:x@y.com">mail</a>'],
      [],
    );
    expect(links).toEqual([
      { text: "Update payment", url: "https://www.youtube.com/paid_memberships?a=1&b=2" },
    ]);
  });

  test("the classifier is told which links it may use", () => {
    const text = describeLinksForClassifier(
      [
        { text: "Update", url: "https://www.youtube.com/paid_memberships" },
        { text: "Finish", url: "https://odd.example.io/" },
      ],
      youtube,
    );
    expect(text).toContain("sender's own domain");
    expect(text).toContain("NOT the sender's domain");
  });

  test("normalize carries the links, which upsert must never see", () => {
    const html = btoa('<a href="https://github.com/thekiwidev/caseforge/actions/runs/1">View run</a>')
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    const n = normalizeMessage({
      id: "m1",
      threadId: "t1",
      payload: { mimeType: "text/html", body: { data: html } },
    } as never);
    expect(n.links).toEqual([
      { text: "View run", url: "https://github.com/thekiwidev/caseforge/actions/runs/1" },
    ]);
  });
});

describe("the alert card", () => {
  const card: CardEmail = {
    emailMessageId: "msg1",
    accountLabel: "primary",
    fromAddress: "no-reply@youtube.com",
    fromName: "YouTube",
    subject: "Your payment didn't go through",
    isSpam: false,
    authResults: PASS,
    importance: "CRITICAL",
    whyItMatters:
      "YouTube couldn't charge your Premium renewal, so Premium may lapse. Update it at [youtube.com/paid_memberships](https://www.youtube.com/paid_memberships).",
  };

  test("keeps the header and buttons, with a tappable link in the summary", () => {
    const composed = composeCard(card, "Africa/Lagos");
    const [head, summary] = composed.text.split("\n");
    expect(head).toContain("🔴 <b>YouTube</b> · primary");
    expect(summary).toContain('<a href="https://www.youtube.com/paid_memberships">');
    const labels = composed.buttons.flat().map((b) => b.text);
    expect(labels).toEqual(["TL;DR", "Full message", "Draft a reply", "Not important"]);
  });

  test("the same card from SPAM never links", () => {
    const composed = composeCard({ ...card, isSpam: true }, "Africa/Lagos");
    expect(composed.text).not.toContain("<a ");
  });

  test("history gets plain text, not markdown", () => {
    expect(cardAsHistory(card, "Africa/Lagos")).toContain(
      "Update it at youtube.com/paid_memberships (https://www.youtube.com/paid_memberships)",
    );
  });
});

describe("next step, decisively", () => {
  test("the planner's next step is parsed and capped", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "I think the next step is to split it into three actions. Should I do it now?",
        tools: [],
        next: "  Break the MLS DPD integration\ninto its next three actions ",
      }),
    );
    expect(plan.next).toBe("Break the MLS DPD integration into its next three actions");
    expect(parseToolPlan(JSON.stringify({ reply: "Done.", tools: [], next: "x".repeat(400) })).next?.length).toBe(160);
    expect(parseToolPlan(JSON.stringify({ reply: "Done.", tools: [] })).next).toBeUndefined();
  });

  test("the voice rules forbid the hedged offer", () => {
    expect(TELEGRAM_FORMAT_CONTRACT).toContain('Never "If you want, I can…"');
    expect(TELEGRAM_FORMAT_CONTRACT).toContain("Should I do it now?");
  });
});
