// Pure. The unread rule for email alerts: an important mail pages the phone
// only while it is still unread, and gets at most one reminder if it stays
// unread for two days.

/** How long an alerted mail may stay unread before the one reminder. */
export const FOLLOWUP_AFTER_MS = 48 * 60 * 60 * 1000;

/** Gmail marks unread mail with the UNREAD label; reading removes it. */
export function isUnread(labelIds: readonly string[]): boolean {
  return labelIds.includes("UNREAD");
}

/** First line of the reminder card. */
export const FOLLOWUP_LEAD = "Important and unread for 48h";

export type AlertStep = "alert" | "stop" | "defer";

/**
 * What to do when an alert step fires. `read` stops the chain at any point;
 * a policy "defer" (quiet hours) keeps it alive; anything else the policy
 * does not send stops it.
 */
export function alertStep(args: { read: boolean; policy: "send" | "drop" | "defer" }): AlertStep {
  if (args.read) return "stop";
  if (args.policy === "send") return "alert";
  return args.policy === "defer" ? "defer" : "stop";
}
