// Pure. User-taught rules about which mail matters, applied BEFORE any model
// call.
//
// WHY THIS IS CODE AND NOT A PROMPT
//
// "Ignore security alerts from Google" written into a prompt is a suggestion
// the classifier may or may not honour on any given message, and it costs a
// model call every time to not-honour it. Written as a rule it is a
// guarantee, and it costs nothing — the message never reaches the model. Same
// principle as Phase 7's per-mailbox priorities: rules are code against
// classifier output, never prompt text.
//
// WHAT THIS REPLACES
//
// The only way to teach an ignore was the [Not important] button, which
// always wrote the exact full address — so "stop showing me anything from
// Google" was unexpressible, and there was no way to list or undo one.
// `noiseSenders.list` and `.remove` existed with zero callers.

export type RuleAction =
  /** Never surface it: classify LOW without a model call. */
  | "IGNORE"
  /** Classify normally, but never send a real-time alert card. */
  | "NEVER_ALERT"
  /** Always treat as at least HIGH, whatever the classifier says. */
  | "FLOOR_HIGH";

export interface EmailRule {
  /** Full address ("a@b.com") or domain ("@b.com"). Domains match subdomains. */
  senderPattern?: string;
  /** Case-insensitive substring of the subject. */
  subjectPattern?: string;
  /** A Gmail labelId, e.g. "CATEGORY_PROMOTIONS". */
  category?: string;
  /**
   * Which connected mailbox this applies to, by its label ("personal",
   * "recruiting"). Absent means every mailbox.
   *
   * With three mailboxes the same sender means different things in each —
   * a recruiter in the recruiting inbox matters, the same recruiter in the
   * personal one may not. Without this, one rule silences all three.
   */
  accountLabel?: string;
  action: RuleAction;
  /** The user's own words, kept for `/rules` so a rule can be recognised. */
  reason?: string;
}

export interface RuleTarget {
  fromAddress: string;
  subject?: string;
  labelIds: string[];
  /** The label of the mailbox this arrived in. */
  accountLabel?: string;
}

/**
 * "google.com" and "@google.com" must mean the same thing — a user typing an
 * ignore rule will not think about the @.
 */
export function normalizePattern(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;
  return `@${trimmed}`;
}

function senderMatches(fromAddress: string, pattern: string): boolean {
  const from = fromAddress.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();

  if (!p.startsWith("@")) return from === p;

  // Domain rule. Match the domain itself and its subdomains, but never a
  // lookalike — "@google.com" must not catch "notgoogle.com", which a bare
  // `endsWith` would.
  const domain = p.slice(1);
  const at = from.lastIndexOf("@");
  if (at === -1) return false;
  const host = from.slice(at + 1);
  return host === domain || host.endsWith(`.${domain}`);
}

function ruleMatches(target: RuleTarget, rule: EmailRule): boolean {
  // accountLabel is a SCOPE, not a condition: a rule that only says
  // "in my personal mailbox" and nothing else would silence that whole
  // mailbox, so it does not count toward having a condition at all.
  if (
    rule.accountLabel &&
    rule.accountLabel.trim().toLowerCase() !== (target.accountLabel ?? "").trim().toLowerCase()
  ) {
    return false;
  }

  const conditions = [rule.senderPattern, rule.subjectPattern, rule.category].filter(Boolean);
  // A rule with no conditions would match everything and silence the whole
  // inbox. Refuse rather than trust that one is never written.
  if (conditions.length === 0) return false;

  if (rule.senderPattern && !senderMatches(target.fromAddress, rule.senderPattern)) {
    return false;
  }
  if (
    rule.subjectPattern &&
    !(target.subject ?? "").toLowerCase().includes(rule.subjectPattern.trim().toLowerCase())
  ) {
    return false;
  }
  if (rule.category && !target.labelIds.includes(rule.category)) {
    return false;
  }
  // Every condition PRESENT must hold. "from Google AND about security" is
  // one rule, not two — otherwise it would silence the user's bank too.
  return true;
}

/**
 * Precedence, strongest first. Ordered by SAFETY, not by specificity or by
 * insertion order: a rule that shows more always beats a rule that shows
 * less, so a broad ignore can never bury something the user separately said
 * was important.
 */
const PRECEDENCE: RuleAction[] = ["FLOOR_HIGH", "NEVER_ALERT", "IGNORE"];

/** The winning rule for this message, or null when none applies. */
export function matchRules(target: RuleTarget, rules: EmailRule[]): EmailRule | null {
  const matched = rules.filter((r) => ruleMatches(target, r));
  if (matched.length === 0) return null;

  for (const action of PRECEDENCE) {
    const hit = matched.find((r) => r.action === action);
    if (hit) return hit;
  }
  return matched[0] ?? null;
}

const ACTION_WORDS: Record<RuleAction, string> = {
  IGNORE: "never show me",
  NEVER_ALERT: "never alert me about",
  FLOOR_HIGH: "always treat as important",
};

/** One line the user can read back and recognise as the thing they asked for. */
export function describeRule(rule: EmailRule): string {
  const parts: string[] = [];
  if (rule.senderPattern) parts.push(`from ${rule.senderPattern}`);
  if (rule.subjectPattern) parts.push(`with "${rule.subjectPattern}" in the subject`);
  if (rule.category) parts.push(`in ${rule.category}`);

  const what = parts.length > 0 ? parts.join(" ") : "(no conditions — never matches)";
  const scope = rule.accountLabel ? ` in ${rule.accountLabel}` : "";
  return `${ACTION_WORDS[rule.action]} mail ${what}${scope}`;
}
