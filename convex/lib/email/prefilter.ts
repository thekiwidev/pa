// Pure. No ctx, no fetch. The deterministic decision tree that runs before
// any model call — see docs/personal-ai-assistant-build-plan-v3-convex.md,
// Phase 4, step 1. Most mail should never reach CLASSIFY_IMPORTANCE.

import type { EmailRule } from "./rules";

export type PrefilterVerdict =
  | {
      skip: true;
      importance: "LOW";
      reason:
        | "user_rule"
        | "noise_sender"
        | "own_message"
        | "bulk_not_high_plus_sender"
        | "promotions_no_project_hit";
    }
  | { skip: false; floor?: "HIGH"; neverAlert?: boolean };

export interface PrefilterInput {
  /** Exact fromAddress or its domain matched a row in noiseSenders. */
  isNoiseSender: boolean;
  /** Gmail's own labelIds for this message (emailMessages.labelIds). */
  labelIds: string[];
  /**
   * Gmail's API surfaces List-Unsubscribe but not a raw Precedence header —
   * its presence is this project's proxy for "this is bulk mail".
   */
  hasListUnsubscribe: boolean;
  /** From people.getByEmail(fromAddress)?.importance, if the sender is known. */
  senderImportance?: "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
  /** True if the subject or body contains a known project's name. */
  projectKeywordHit: boolean;
  /**
   * The winning user-taught rule for this message, from
   * lib/email/rules.ts#matchRules. Resolved by the caller because matching
   * needs the rule rows; applying it is pure and belongs here.
   */
  userRule?: EmailRule | null;
  /**
   * The subject or body reads like a transactional notice about the owner's
   * own account, money or work (looksTransactional below). Bulk-sender
   * headers alone must not bury these.
   */
  transactionalHint?: boolean;
}

/**
 * Notices that arrive through bulk-mail infrastructure but are about the
 * owner personally. GitHub, YouTube, Linear, WakaTime and every payment or
 * shipping service send with a List-Unsubscribe header, so "has
 * List-Unsubscribe" is NOT "is a newsletter" — the old rule skipped every one
 * of these without a model call, which is most of what the owner missed.
 *
 * Deliberately broad: a match only buys a classifier call, it decides
 * nothing. The classifier still calls a routine one NORMAL.
 */
const TRANSACTIONAL = new RegExp(
  [
    "sign[- ]?in", "log[- ]?in", "new device", "password", "security (alert|notice)",
    "two-factor", "2fa", "suspicious", "unusual activity", "oauth", "third-party app",
    "authori[sz]ed",
    "payment (failed|declined|unsuccessful|issue|problem)", "(couldn.t|could not|unable to) (charge|process|bill)",
    "card (declined|expired|expiring)", "billing", "invoice", "refund", "payout", "overdue",
    "past due", "suspend", "paused", "cancel", "renewal",
    "action (required|needed)", "(build|ci|run|check|deploy(ment)?|workflow|job)s? (failed|failing|errored)",
    "failed", "api key", "deprecat", "breaking change", "shipment", "tracking number",
    "account (created|opened|was created)", "verify your", "interview",
  ].join("|"),
  "i",
);

export function looksTransactional(subject?: string, body?: string): boolean {
  return TRANSACTIONAL.test(`${subject ?? ""}\n${(body ?? "").slice(0, 2000)}`);
}

const HIGH_PLUS = new Set(["CRITICAL", "HIGH"]);

/**
 * Decision tree, in order:
 *   0. user rule FLOOR_HIGH           → floor of HIGH, still classify
 *   1. user rule IGNORE               → LOW, no model call
 *   1b. user rule NEVER_ALERT         → classify, but suppress the alert
 *   1c. the owner's own SENT/DRAFT    → LOW, no model call
 *   2. known noise sender             → LOW, no model call
 *   3. bulk AND sender not HIGH+      → LOW, no model call,
 *      unless it reads transactional
 *   4. CATEGORY_PROMOTIONS, no hit    → LOW, no model call,
 *      unless it reads transactional
 *   5. sender importance CRITICAL     → floor of HIGH, still classify
 *   6. otherwise                      → classify with no floor
 *
 * User rules come FIRST because they are the one signal the user stated
 * explicitly; every rule below them is this system's inference. An explicit
 * instruction should never lose to a heuristic.
 *
 * FLOOR_HIGH is checked before IGNORE for the same safety reason matchRules
 * orders them that way — showing too much is recoverable, silently burying a
 * message the user called important is not.
 */
export function prefilter(input: PrefilterInput): PrefilterVerdict {
  const rule = input.userRule;
  if (rule) {
    if (rule.action === "FLOOR_HIGH") return { skip: false, floor: "HIGH" };
    if (rule.action === "IGNORE") {
      return { skip: true, importance: "LOW", reason: "user_rule" };
    }
    if (rule.action === "NEVER_ALERT") return { skip: false, neverAlert: true };
  }

  if (input.labelIds.includes("SENT") || input.labelIds.includes("DRAFT")) {
    return { skip: true, importance: "LOW", reason: "own_message" };
  }

  if (input.isNoiseSender) {
    return { skip: true, importance: "LOW", reason: "noise_sender" };
  }

  const senderIsHighPlus =
    input.senderImportance !== undefined && HIGH_PLUS.has(input.senderImportance);

  if (input.hasListUnsubscribe && !senderIsHighPlus && !input.transactionalHint) {
    return { skip: true, importance: "LOW", reason: "bulk_not_high_plus_sender" };
  }

  if (
    input.labelIds.includes("CATEGORY_PROMOTIONS") &&
    !input.projectKeywordHit &&
    !input.transactionalHint
  ) {
    return { skip: true, importance: "LOW", reason: "promotions_no_project_hit" };
  }

  if (input.senderImportance === "CRITICAL") {
    return { skip: false, floor: "HIGH" };
  }

  return { skip: false };
}
