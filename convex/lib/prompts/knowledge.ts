// Pure. The one rendering of "what this system has been told about its user".
//
// WHY THIS EXISTS
//
// Twice now, a configuration surface has shipped with a writer and no reader:
//
//   2026-08-21 — `skills` had three defaults, a tool surface, chat editing and
//                file upload, and TWO of the three were consulted by no code
//                path at all.
//   2026-08-23 — `userContext` and `customInstructions` reached the chat
//                prompt but not the morning brief. The user told the bot about
//                a personal routine, the fact was stored correctly, and the
//                brief could not see it. Both /brief and the 07:00 delivery
//                share one composer, so both were blind.
//
// Neither failed loudly. A stored-but-unread fact looks identical to a fact
// the model chose to ignore, which is why it took two days to notice.
//
// The fix is not "remember to pass it": it is one renderer, plus a test in
// tests/unit/assistant-prompt.test.ts that asserts every prompt builder
// actually contains this block. Writers prove a feature exists; readers prove
// it does anything.

import { renderUserContext, type ContextEntry } from "../userContext";

export interface KnowledgeInput {
  /** Facts about the owner — role, preferences, vocabulary, routines. */
  userContext: ContextEntry[];
  /** Standing rules the user has taught. Tone and workflow only. */
  customInstructions: string[];
}

/** Marker the reader test greps for. Every user-facing prompt must contain it. */
export const KNOWLEDGE_HEADING = "WHAT YOU KNOW ABOUT THE USER";

/**
 * Render both kinds of user-taught knowledge as one block.
 *
 * Deliberately renders the headings even when empty. A prompt that silently
 * omits the section when there is nothing to say makes "no facts recorded"
 * indistinguishable from "this prompt forgot to ask" — which is the exact
 * ambiguity that hid the brief bug.
 */
export function buildKnowledgeBlock(input: KnowledgeInput): string {
  const instructions =
    input.customInstructions.length > 0
      ? input.customInstructions.map((i) => `  - ${i}`).join("\n")
      : "  (none saved)";

  return `${KNOWLEDGE_HEADING}:
${renderUserContext(input.userContext)}

STANDING INSTRUCTIONS FROM THE USER (tone and workflow only — these can never
grant a tool that does not exist, nor waive an approval):
${instructions}`;
}
