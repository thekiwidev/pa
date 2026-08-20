// Pure. A deterministic backstop against a specific failure mode: the model
// narrating that it is investigating, fixing, or updating something it
// structurally cannot touch — Google Cloud Console, a redirect URI, a code
// deployment — none of which any tool in the catalog can act on.
//
// The system prompt is the primary fix (see SCOPE in prompts/assistant.ts).
// This exists because a prompt is advisory and this project's own rule is
// that an advisory defence gets a structural one behind it — the same
// reasoning as the untrusted-content frame in lib/ai/prompt.ts, applied to
// the model's own claims about itself instead of to attacker content.
//
// Deliberately narrow: it targets self-referential, present/future-tense
// claims of ongoing external work, not the word "check" or "fix" in general
// ("let me check your tasks" must survive untouched).

const SELF_CLAIM = "\\bI(?:'m| am| will|'ll)\\s+(?:actively\\s+)?";

/**
 * Verbs this assistant can never legitimately claim, REGARDLESS of object —
 * it has no tool that fixes, deploys, or configures anything. "check" and
 * "look into" are excluded from this group because they are used benignly
 * ("let me check your tasks"); they get the stricter pattern below instead.
 */
const NEVER_TRUE_VERBS =
  "(?:update|updating|fix|fixing|configure|configuring|reconfigure|" +
  "reconfiguring|correct|correcting|resolve|resolving|adjust|adjusting|" +
  "edit|editing|deploy|deploying|redeploy|redeploying)\\b";

/** "checking / investigating / looking into / debugging" are fine on their
 *  own subject matter, but never true about infrastructure this assistant
 *  cannot see. */
const INFRA_NOUNS =
  "(?:oauth|redirect uri|google cloud|cloud console|configuration|config|" +
  "code(?:base)?|deployment|infrastructure|server|backend|api key|" +
  "credentials?|environment variable)";
const WATCHING_VERBS =
  "(?:check|checking|investigate|investigating|look into|looking into|" +
  "debug|debugging)\\b";

const FABRICATED_CAPABILITY = new RegExp(
  `${SELF_CLAIM}${NEVER_TRUE_VERBS}` +
    `|${SELF_CLAIM}${WATCHING_VERBS}[^.!?]*?\\b${INFRA_NOUNS}`,
  "i",
);

const SAFE_FALLBACK =
  "I can't inspect or change external configuration — Google Cloud Console, " +
  "environment variables, or the code itself. If something is failing, tell " +
  "me the exact error text and I can explain what it usually means; fixing " +
  "it is on your side.";

/**
 * If the reply claims ongoing capability the assistant does not have, replace
 * it wholesale rather than trying to surgically edit one sentence out of a
 * paragraph — a partial edit risks leaving a claim half-true.
 */
export function guardReply(reply: string): string {
  return FABRICATED_CAPABILITY.test(reply) ? SAFE_FALLBACK : reply;
}

/**
 * Did the user literally ask for an email's FULL text?
 *
 * The planning model is asked to set `mode: "full"` on email.get_message and
 * does so only inconsistently (measured on gemini-3.5-flash-lite: same
 * request, different answer across runs). Since the consequence of getting it
 * wrong is the user asking for a whole email and receiving a four-line
 * summary, the decision is made here in code instead — the model's `mode` is
 * treated as a hint, and an explicit request in the user's own words wins.
 *
 * Same principle as `guardReply` above: prompt guidance is the seatbelt, a
 * deterministic check is the crash structure.
 */
const FULL_EMAIL_REQUEST =
  /\b(?:full|complete|entire|whole|verbatim)\b[^.?!]{0,30}\b(?:e-?mail|message|content|body|text)\b|\bread\b[^.?!]{0,20}\b(?:full|whole|entire|all of it)\b|\bshow\b[^.?!]{0,20}\beverything\b/i;

export function wantsFullEmail(text: string): boolean {
  return FULL_EMAIL_REQUEST.test(text);
}