// Pure. No ctx, no fetch. Deterministic floor/ceiling adjustment applied to
// the Phase 4 classifier's output, keyed on connectedAccounts.priorityRules.
//
// This runs BETWEEN the classifier and the Phase 5 delivery-rule branch. It
// is code applied to a model's output, never a prompt instruction — a prompt
// instruction is a suggestion; this is a guarantee. "Every interview email
// from the recruiting mailbox is at least CRITICAL" is a promise a rule
// engine can keep and a system prompt cannot.

export type Importance = "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "IGNORE";

const RANK: Record<Importance, number> = {
  IGNORE: 0,
  LOW: 1,
  NORMAL: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const IMPORTANCE_BY_RANK: readonly Importance[] = [
  "IGNORE",
  "LOW",
  "NORMAL",
  "HIGH",
  "CRITICAL",
];

/**
 * Matches the JSON shape stored on `connectedAccounts.priorityRules`
 * (`v.any()` in schema.ts — this is the type it actually holds).
 */
export interface PriorityRuleCondition {
  /** The classifier's `category` field, e.g. "INTERVIEW", "PROMOTION". */
  category?: string;
}

export interface PriorityRule {
  when: PriorityRuleCondition;
  minImportance?: Importance;
  maxImportance?: Importance;
}

export interface PriorityRules {
  label: string;
  floors?: PriorityRule[];
  ceilings?: PriorityRule[];
  /** Whether to apply these rules to messages already in SPAM. Read by the
   *  caller in convex/gmail.ts — this module only applies the floor/ceiling
   *  math, it does not know what folder a message is in. */
  scanSpam?: boolean;
}

function matches(when: PriorityRuleCondition, category: string | undefined): boolean {
  if (!when.category) return true;
  return when.category === category;
}

/**
 * Floors raise a rank, ceilings lower one — applied in that order, so a
 * ceiling always has the final word for a category that somehow matches
 * both a floor and a ceiling. The build plan's own example rule sets never
 * do this, but the order is a deliberate choice, not an accident of
 * iteration, and it's what the tests below pin down.
 *
 * A floor never LOWERS a rank the classifier already gave, and a ceiling
 * never RAISES one — each only pulls in its own direction.
 */
export function applyPriorityRules(
  importance: Importance,
  category: string | undefined,
  rules: PriorityRules | undefined,
): Importance {
  if (!rules) return importance;

  let rank = RANK[importance];

  for (const floor of rules.floors ?? []) {
    if (floor.minImportance && matches(floor.when, category)) {
      rank = Math.max(rank, RANK[floor.minImportance]);
    }
  }
  for (const ceiling of rules.ceilings ?? []) {
    if (ceiling.maxImportance && matches(ceiling.when, category)) {
      rank = Math.min(rank, RANK[ceiling.maxImportance]);
    }
  }

  return IMPORTANCE_BY_RANK[rank]!;
}

/**
 * Narrow the untyped `connectedAccounts.priorityRules` column.
 *
 * The column is `v.any()`, so what comes out of the database is genuinely
 * unknown — hand-written JSON, edited by whoever set the mailbox up. A blind
 * cast would turn a typo into a crash inside the sync loop, where the only
 * symptom is mail silently not classifying. Anything malformed is dropped
 * with a reason instead, and the message keeps the classifier's own verdict.
 */
export function parsePriorityRules(raw: unknown): PriorityRules | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const o = raw as Record<string, unknown>;
  const rules: PriorityRules = {
    label: typeof o.label === "string" ? o.label : "",
    scanSpam: o.scanSpam === true,
  };

  const parseSide = (value: unknown, key: "minImportance" | "maxImportance"): PriorityRule[] => {
    if (!Array.isArray(value)) return [];
    const out: PriorityRule[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const level = e[key];
      if (typeof level !== "string" || !(level in RANK)) continue;

      const when = typeof e.when === "object" && e.when !== null
        ? (e.when as Record<string, unknown>)
        : {};
      out.push({
        when: { category: typeof when.category === "string" ? when.category : undefined },
        [key]: level as Importance,
      } as PriorityRule);
    }
    return out;
  };

  rules.floors = parseSide(o.floors, "minImportance");
  rules.ceilings = parseSide(o.ceilings, "maxImportance");

  // Nothing usable survived — treat as absent so the caller short-circuits.
  if (rules.floors.length === 0 && rules.ceilings.length === 0) return undefined;
  return rules;
}
