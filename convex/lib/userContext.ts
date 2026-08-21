// Pure. No ctx, no fetch — runs under plain `bun test`.
//
// Facts ABOUT the user, as distinct from customInstructions (rules for
// behaviour) and skills (procedures for a capability). See the table at the
// top of docs/build/PHASE-02B-user-context.md for why these are three things
// and not one.

export const CONTEXT_CATEGORIES = [
  "profile", // role, qualifications, what they do
  "preferences", // tone, format, how they like to be addressed
  "working_style", // hours, timezone habits, how they plan
  "domain", // industry terms, project vocabulary, acronyms
  "relationships", // who matters to them and why
  "other", // the escape hatch — deliberately last
] as const;

export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

export interface ContextEntry {
  category: ContextCategory;
  text: string;
}

/**
 * These render on EVERY planning call, so the product of the two is a fixed
 * tax on every message the bot ever handles. Raising them is a cost decision,
 * not a convenience one — there is a test asserting the product stays small.
 */
export const MAX_CONTEXT_ENTRIES = 40;
export const MAX_ENTRY_CHARS = 280;

/**
 * A user-supplied category is normalized, never rejected. Dropping a fact
 * because it did not match a bucket loses information the user volunteered;
 * filing it under "other" loses only tidiness.
 */
export function normalizeCategory(raw: string): ContextCategory {
  const slug = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (CONTEXT_CATEGORIES as readonly string[]).includes(slug)
    ? (slug as ContextCategory)
    : "other";
}

/** Grouped by category, in CONTEXT_CATEGORIES order — stable across calls,
 *  so the prompt does not churn just because rows were inserted in a
 *  different order. */
export function renderUserContext(entries: ContextEntry[]): string {
  if (entries.length === 0) return "  (nothing recorded yet)";

  const lines: string[] = [];
  for (const category of CONTEXT_CATEGORIES) {
    const inCategory = entries.filter((e) => e.category === category);
    if (inCategory.length === 0) continue;
    lines.push(`  ${category.toUpperCase()}`);
    for (const e of inCategory) lines.push(`    - ${e.text}`);
  }
  return lines.join("\n");
}
