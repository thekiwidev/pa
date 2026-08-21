// Pure. No ctx, no fetch. The deterministic decision tree that runs before
// any model call — see docs/personal-ai-assistant-build-plan-v3-convex.md,
// Phase 4, step 1. Most mail should never reach CLASSIFY_IMPORTANCE.

export type PrefilterVerdict =
  | { skip: true; importance: "LOW"; reason: "noise_sender" | "bulk_not_high_plus_sender" | "promotions_no_project_hit" }
  | { skip: false; floor?: "HIGH" };

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
}

const HIGH_PLUS = new Set(["CRITICAL", "HIGH"]);

/**
 * Decision tree, in order:
 *   1. known noise sender             → LOW, no model call
 *   2. bulk AND sender not HIGH+      → LOW, no model call
 *   3. CATEGORY_PROMOTIONS, no hit    → LOW, no model call
 *   4. sender importance CRITICAL     → floor of HIGH, still classify
 *   5. otherwise                      → classify with no floor
 */
export function prefilter(input: PrefilterInput): PrefilterVerdict {
  if (input.isNoiseSender) {
    return { skip: true, importance: "LOW", reason: "noise_sender" };
  }

  const senderIsHighPlus =
    input.senderImportance !== undefined && HIGH_PLUS.has(input.senderImportance);

  if (input.hasListUnsubscribe && !senderIsHighPlus) {
    return { skip: true, importance: "LOW", reason: "bulk_not_high_plus_sender" };
  }

  if (input.labelIds.includes("CATEGORY_PROMOTIONS") && !input.projectKeywordHit) {
    return { skip: true, importance: "LOW", reason: "promotions_no_project_hit" };
  }

  if (input.senderImportance === "CRITICAL") {
    return { skip: false, floor: "HIGH" };
  }

  return { skip: false };
}
