// Pure. The boundary between "what a model wrote" and "what gets emailed".
//
// WHY THIS EXISTS
//
// On 2026-08-23 a real recipient received an email whose body was the
// assistant's own chat narration: "Here is a draft reply based on your
// instructions", a `### Draft reply` heading, a `**To:**` envelope, and
// "Please review the draft. If everything looks good, let me know and I will
// proceed with sending it."
//
// Nothing failed. The approval gate worked perfectly — it bound itself to a
// hash of exactly the bytes that were sent. The defect was upstream: the
// body-generation call was given `DEFAULT_SKILLS.draft_reply`, a ~470-line
// CHAT-PRESENTATION procedure, as its system prompt, and the router persisted
// the entire raw completion as `bodyText`. A document describing how to show a
// draft to the user was used as the prompt for writing one.
//
// Two structural changes follow from that, and both live here:
//
//   1. The body is a FIELD, not a completion. `{"body": "..."}` is parsed, so
//      any narration the model wraps around it is discarded rather than
//      concatenated. A skill can still govern voice and length; it can no
//      longer redefine what the output IS.
//   2. A completion that still smells like narration is REFUSED. No draft row,
//      no approval, no send — a plain error instead. The old failure mode was
//      silent because the chat preview echoed the same string, so the review
//      step the user was asked to perform showed them the corruption formatted
//      to look correct.

import { parseJsonObject } from "../json";

/**
 * Appended AFTER the user's skill so it is the last thing the model reads.
 *
 * Same shape as `COMPOSE_INVARIANTS` in convex/briefs.ts and for the same
 * reason (MEMORY.md, 2026-08-21): user-authored content governs FORMAT,
 * invariants that must always hold are appended after it. A skill may say
 * "sign off as Ade" and be obeyed; it may not say "show a To: line" and have
 * that reach an inbox.
 */
export const BODY_OUTPUT_CONTRACT = `
OUTPUT CONTRACT — overrides anything above that conflicts with it.

Reply with a single JSON object and nothing else:

{ "body": "the reply body text" }

"body" is the message that will be sent to the recipient, verbatim. Therefore:
- Write it AS the user, addressed TO the recipient. Never write about the
  reply, and never address the user.
- NO "To:", "From:", "Subject:", "Cc:" line. The system sets those.
- NO heading of any kind (no "#", no "Draft reply", no title line).
- NO horizontal rule ("***", "---", "___").
- NO preamble ("Here is a draft…") and NO closing note ("Please review…",
  "Let me know if you'd like changes"). Those belong in chat, not in an email.
- Start with the greeting. End with the sign-off. Nothing outside them.
- Light emphasis (**bold**) and "- " bullets are fine. Nothing else.`;

/**
 * Markers that mean the model wrote ABOUT a reply instead of writing one.
 *
 * Each pattern below was present in the message that actually shipped. This is
 * deliberately a denylist of observed narration rather than a grammar for
 * "valid email", because the failure is stereotyped: it is the shape the
 * draft_reply skill's §16 and §17 prescribe, and near-misses of that shape.
 */
const NARRATION_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^\s*#{1,6}\s+\S/m, reason: "contains a markdown heading" },
  { pattern: /^\s*(\*\*)?(To|From|Subject|Cc|Bcc)(\*\*)?\s*:/im, reason: "contains an envelope header line" },
  { pattern: /^\s*(\*{3,}|-{3,}|_{3,})\s*$/m, reason: "contains a horizontal rule" },
  { pattern: /\bhere(?:'s| is| are)\b[^.\n]{0,40}\bdrafts?\b/i, reason: "opens by announcing a draft" },
  { pattern: /\bplease review\b/i, reason: "asks the reader to review a draft" },
  { pattern: /\bi (?:have |'ve )?draft(?:ed)?\b/i, reason: "describes drafting rather than writing the reply" },
  { pattern: /\blet me know (?:if|and) i(?:'ll| will)\b[^.\n]{0,40}\bsend\b/i, reason: "offers to send, which is the user's tap" },
  { pattern: /\bbased on your instructions?\b/i, reason: "addresses the user rather than the recipient" },
  { pattern: /\bdraft repl(?:y|ies)\b/i, reason: "refers to the draft as an object" },
];

/**
 * Returns the reason a body looks like narration, or null when it reads as an
 * actual message. Null is the pass condition.
 */
export function looksLikeNarration(body: string): string | null {
  for (const { pattern, reason } of NARRATION_PATTERNS) {
    if (pattern.test(body)) return reason;
  }
  return null;
}

export type DraftBodyResult =
  | { ok: true; body: string }
  | { ok: false; reason: string };

/**
 * Turn a DRAFT_REPLY completion into a body, or refuse.
 *
 * Refusing is a first-class outcome. The caller must NOT fall back to the raw
 * text — that fallback is precisely the bug this module exists to close.
 */
export function extractDraftBody(raw: string): DraftBodyResult {
  const parsed = parseJsonObject(raw);
  if (parsed === null) {
    return {
      ok: false,
      reason: "the reply writer did not return the expected JSON object",
    };
  }

  const value = parsed.body;
  if (typeof value !== "string") {
    return { ok: false, reason: 'the reply writer returned no "body" field' };
  }

  const body = value.trim();
  if (body.length === 0) {
    return { ok: false, reason: "the reply writer returned an empty body" };
  }

  const narration = looksLikeNarration(body);
  if (narration !== null) {
    return {
      ok: false,
      reason: `the reply writer produced narration, not a message body — it ${narration}`,
    };
  }

  return { ok: true, body };
}
