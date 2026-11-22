// Pure. The owner's plain-words answer to "what is important to me", kept in
// userContext under one category (no new table: MEMORY 2026-08-24 says not
// to add a third rule system). Each entry is one sentence that starts with
// its direction, "alert me: ..." or "never alert: ...".

export const EMAIL_IMPORTANCE_CATEGORY = "email_importance";

/**
 * Criteria go to the classifier whole and apart from the capped owner facts,
 * so the 16th fact can never push out a rule the owner wrote on purpose.
 */
export function splitOwnerContext(entries: readonly { category: string; text: string }[]): {
  facts: string[];
  criteria: string[];
} {
  const facts: string[] = [];
  const criteria: string[] = [];
  for (const e of entries) (e.category === EMAIL_IMPORTANCE_CATEGORY ? criteria : facts).push(e.text);
  return { facts, criteria };
}

/** Categories narrow enough that "never alert for these" is a sane sentence. */
const SILENCEABLE: Record<string, string> = {
  SECURITY_ALERT: "routine security and sign-in notices",
  PROMOTION: "promotions",
  NEWSLETTER: "newsletters",
};

/**
 * The criterion offered after "Not important", from the classifier's own
 * category enum. Nothing from the email's subject or body is ever copied
 * into it: that text is sender-written and this sentence is trusted policy.
 */
export function categoryCriterion(category: string | undefined): string | null {
  const phrase = category ? SILENCEABLE[category] : undefined;
  return phrase ? `never alert: ${phrase}` : null;
}
