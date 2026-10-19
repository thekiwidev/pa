// Pure. "Is this message a moment for a verse?" — a cheap word check that
// runs on every inbound message with no model call.
//
// It only has to notice; choosing the verse is the chooser's job, with the
// whole conversation in front of it. So the patterns are deliberately
// narrow: "I'm so angry", "applying for a job", "I want to give up" — not
// "should I" or "client", which a planner hears all day. A missed moment
// costs one verse; a false one teaches the owner to ignore them.

import type { NeedId } from "./needs";

export interface Moment {
  need: NeedId;
  /** The words that matched, for the audit log and the chooser. */
  cue: string;
}

/** First match wins, so the order is the priority: integrity before comfort. */
const PATTERNS: [NeedId, RegExp][] = [
  [
    "check",
    /\b(get (my )?revenge|pay (him|her|them) back|tempted|temptation|(want|going) to lie|lie to (him|her|them|my)|cut corners|cheat(ing)? on|fake (it|the numbers)|i('m| am) (being )?lazy|procrastinat\w*|wasting (my )?time|doom ?scroll\w*|can'?t stop (scrolling|watching))\b/i,
  ],
  [
    "peace",
    /\b(so (angry|mad|pissed|annoyed|frustrated|stressed|anxious)|i('m| am) (really |so |very )?(angry|furious|livid|pissed( off)?|stressed( out)?|anxious|panicking|overwhelmed|frustrated|on edge)|stressing (me )?out|panic(king)? attack|calm (myself )?down|need to (breathe|relax|calm)|losing my (mind|temper|cool)|can'?t (sleep|think straight)|overthinking|freaking out)\b/i,
  ],
  [
    "perseverance",
    /\b(give up|giving up|quit(ting)? everything|burn(ed|t)? ?out|exhausted|so tired|i('m| am) tired of|drained|can'?t (do|take) (this|it) anymore|no strength|worn out|running on empty|want to stop)\b/i,
  ],
  [
    "work",
    /\b(apply(ing)? (for|to) (a |the |this |that )?(job|role|position|internship|grant|scholarship)|job (application|hunt(ing)?|search(ing)?|interview)|(an |the |my )interview|cover letter|my (cv|resume|résumé)|pitch(ing)? (to|the)|salary negotiation|launch(ing)? (the|my|our)|(big|important) (deal|contract|client|presentation)|rent is due|broke (this|right) now|money is tight)\b/i,
  ],
  [
    "affirmation",
    /\b(rejected|rejection|not good enough|impostor|imposter|i('m| am) a failure|i('m| am) (useless|worthless|stupid|behind)|everyone else is ahead|they didn'?t pick me|got turned down|nobody (cares|believes in me))\b/i,
  ],
  [
    "joy",
    /\b(i('m| am) (so |really |feeling )?(sad|down|lonely|depressed|miserable|heartbroken|low)|feeling (down|low|blue)|bad day|terrible day|rough day|crying|cried)\b/i,
  ],
  [
    "faith",
    /\b(i('m| am) (so |really )?(worried|scared|afraid)|what if it (fails|doesn'?t work)|losing (hope|faith)|doubt(ing)? (god|myself|it)|nothing is working|still waiting (on|for) (god|an answer|a reply|news))\b/i,
  ],
  [
    "guidance",
    /\b(can'?t decide|torn between|don'?t know what to do|which (one|offer|path) should i (take|choose|pick)|big decision|at a crossroads)\b/i,
  ],
  [
    "walk",
    /\b(haven'?t (prayed|read (my|the) bible)|my spiritual life|far from god|drifting from god|backslid\w*|need to pray more|my walk with god|quiet time)\b/i,
  ],
  [
    "thanksgiving",
    /\b(got the (job|offer|role|contract)|thank (god|you lord|you jesus)|god did it|it worked|we did it|good news|answered prayer|prayer (was )?answered|i passed|they said yes|got accepted|got hired)\b/i,
  ],
];

export function detectMoment(text: string): Moment | null {
  const t = text.trim();
  if (!t || t.startsWith("/")) return null;
  for (const [need, re] of PATTERNS) {
    const m = re.exec(t);
    if (m) return { need, cue: m[0] };
  }
  return null;
}
