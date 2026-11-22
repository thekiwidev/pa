// Pure. What counts as news for this owner when they have said nothing: product
// and model launches from the AI labs and developer platforms, and offers that
// change what they pay. These are standing explicit interests with no expiry,
// merged in at ranking time; they are never stored, so changing this list needs
// no migration. The owner's own words ("no more X") still override them.

import { interestWeight, type Interest } from "./rank";

export const BASELINE_TOPICS: readonly string[] = [
  "Anthropic Claude launch",
  "OpenAI GPT ChatGPT launch",
  "Google Gemini launch",
  "new AI model release",
  "AI product announcement",
  "free AI plan students pricing",
  "new developer tool launch",
];

/** Run as news searches every time a newsletter is built. */
export const LAUNCH_QUERIES: readonly string[] = [
  "new AI model released OpenAI Anthropic Google Gemini",
  "AI product launch announcement developers",
  "free AI plan offer pricing change students",
];

export function baselineInterests(nowMs: number): Interest[] {
  return BASELINE_TOPICS.map((topic) => ({ topic, weight: 1, origin: "explicit", createdAt: nowMs }));
}

/** The fixed launch queries plus up to three of the owner's live positive explicit topics. */
export function launchQueries(interests: readonly Interest[], nowMs: number): string[] {
  const own: string[] = [];
  for (const i of interests) {
    if (i.origin !== "explicit" || interestWeight(i, nowMs) <= 0) continue;
    const topic = i.topic.trim();
    if (topic && !own.includes(topic)) own.push(topic);
    if (own.length === 3) break;
  }
  return [...LAUNCH_QUERIES, ...own.map((t) => `${t} news`)];
}
