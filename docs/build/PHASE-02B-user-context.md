# Phase 2B — User context

**Build documentation.** Follow it top to bottom. Every step names the exact file, says what that file is for, gives you the content, and tells you how to check it worked.

- **Architecture reference:** not in the source build plan — added on direct request. Extends Phase 2's structured-memory domain (`docs/personal-ai-assistant-build-plan-v3-convex.md` → *Phase 2*).
- **Prerequisite:** Phases 0–3 complete — you have them.
- **Buildable immediately.** Nothing here depends on Phases 4–8. The "2B" number says where it belongs in the domain model, not where it sits in a queue.

---

## What you'll have at the end

The assistant knows who you are without being told again every message: what you do, what you're qualified in, how you like to be written to, what your working hours are, what a term means in your world. You teach it in plain language — *"I'm a frontend engineer, mostly React and TypeScript"* — and it holds that permanently, uses it to tailor every reply, and lets you correct or delete any of it by asking.

---

## Why this is a third thing, not a variant of the two you already have

The bot already stores two kinds of user-taught knowledge. This is a third, and conflating them is the mistake this phase exists to avoid:

| | Holds | Injected | Example |
|---|---|---|---|
| `customInstructions` | **Rules for behaviour** | every message | "Keep replies under two sentences" |
| `skills` | **Procedures** for one capability | only when keyword-matched | "When checking email: 1. …" |
| **`userContext`** (this phase) | **Facts about the person** | every message | "Frontend engineer, React/TypeScript" |

A fact is not an instruction. *"I'm a frontend engineer"* tells the model nothing to **do** — it tells the model who it is talking to, which changes what counts as important mail, what tone a draft should take, and whether "the OTP thing" needs explaining. Storing that as an instruction ("always remember I am a frontend engineer") works badly, because instructions are read as commands and the model starts announcing your job at you.

**Facts are also the missing input for anything personalized.** Phase 4's classifier can't judge whether a recruiter email matters without knowing you're job-hunting. Phase 21's *"TL;DR for me"* is undefined without knowing who "me" is. This phase is what makes those answerable.

---

## File manifest

Create or edit these, in this order.

| # | File | New/Edit | What it is |
|---|---|---|---|
| 1 | `tests/unit/user-context.test.ts` | new | The failing test — categories, bounds, rendering |
| 2 | `convex/lib/userContext.ts` | new | **Pure.** Categories, limits, prompt rendering |
| 3 | `convex/schema.ts` | edit | Add the `userContext` table |
| 4 | `convex/model/userContext.ts` | new | The only reads and writes |
| 5 | `convex/lib/tools/catalog.ts` | edit | `context.set`, `context.list`, `context.remove` |
| 6 | `convex/tools/router.ts` | edit | Dispatch for those three |
| 7 | `convex/lib/tools/outcomes.ts` | edit | Render their results |
| 8 | `convex/lib/prompts/assistant.ts` | edit | Inject context into the planning prompt |
| 9 | `tests/unit/assistant-prompt.test.ts` | edit | Assert it reaches the prompt |
| 10 | `convex/assistant.ts` | edit | Load it in `converse()`; add `/context` |

---

## Step 1 — Write the failing test

**File:** `tests/unit/user-context.test.ts` **(create)**

**What this file is for.** Encodes the two rules that matter before any storage exists: context is **categorised** (so the prompt can group it rather than dumping a flat list), and it is **bounded** (it renders on every single message, so an unbounded list is an unbounded per-message token cost — the exact shape of the two-calls-per-message bug that once exhausted the Gemini quota).

```ts
import { describe, expect, test } from "bun:test";
import {
  CONTEXT_CATEGORIES,
  MAX_CONTEXT_ENTRIES,
  MAX_ENTRY_CHARS,
  normalizeCategory,
  renderUserContext,
  type ContextEntry,
} from "../../convex/lib/userContext";

const entry = (over: Partial<ContextEntry> = {}): ContextEntry => ({
  category: "profile",
  text: "Frontend engineer, mostly React and TypeScript",
  ...over,
});

describe("normalizeCategory", () => {
  test("accepts a known category in any case", () => {
    expect(normalizeCategory("PROFILE")).toBe("profile");
    expect(normalizeCategory("Working Style")).toBe("working_style");
  });

  test("falls back to 'other' rather than rejecting an unknown one", () => {
    // A fact the user volunteered must never be DROPPED because it did not
    // fit a bucket. Losing it is worse than filing it imperfectly.
    expect(normalizeCategory("astrological sign")).toBe("other");
  });
});

describe("renderUserContext", () => {
  test("says so explicitly when nothing is known yet", () => {
    expect(renderUserContext([])).toContain("(nothing recorded yet)");
  });

  test("groups by category rather than emitting a flat list", () => {
    const out = renderUserContext([
      entry({ category: "profile", text: "Frontend engineer" }),
      entry({ category: "preferences", text: "Prefers short replies" }),
    ]);
    expect(out).toContain("PROFILE");
    expect(out).toContain("PREFERENCES");
    expect(out.indexOf("PROFILE")).toBeLessThan(out.indexOf("PREFERENCES"));
  });

  test("renders every entry's text verbatim", () => {
    const out = renderUserContext([entry({ text: "Based in Lagos, WAT" })]);
    expect(out).toContain("Based in Lagos, WAT");
  });
});

describe("bounds", () => {
  test("the entry cap is small enough to render every message", () => {
    // This is not arbitrary: MAX_CONTEXT_ENTRIES * MAX_ENTRY_CHARS is the
    // worst-case tokens added to EVERY planning call. Keep the product low.
    expect(MAX_CONTEXT_ENTRIES * MAX_ENTRY_CHARS).toBeLessThan(12_000);
  });

  test("every category is lower_snake_case", () => {
    for (const c of CONTEXT_CATEGORIES) expect(c).toMatch(/^[a-z_]+$/);
  });
});
```

**Verify:** `bun test tests/unit/user-context.test.ts` — fails to resolve the import. Expected.

---

## Step 2 — The pure layer

**File:** `convex/lib/userContext.ts` **(create)**

**What this file is for.** Categories, the bounds, and the exact string the model sees. Pure — no `ctx`, no I/O — so the prompt fragment is unit-testable, same boundary as everything else in `convex/lib/`.

```ts
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
```

**Verify:** `bun test tests/unit/user-context.test.ts` — all pass. `bun run typecheck` — clean.

---

## Step 3 — The table

**File:** `convex/schema.ts` **(edit)**

**What this does.** One row per fact. A dedicated table rather than a growing array on a `preferences` document, per the schema guideline against unbounded arrays in one document — and because per-row storage is what makes "forget the thing about X" a delete rather than a rewrite.

> The `preferences` table already exists from Phase 2 and is still unused. It is deliberately NOT reused here: `preferences` is typed key/value (`working_hours` → `09:00-18:00`), where this is free-text facts. Phase 05B's `briefConfig` is the natural first consumer of `preferences`; leave it for that.

Add after `customInstructions`:

```ts
  /**
   * Not in the build plan — added on direct request. Facts ABOUT the owner
   * that tailor every reply: role, qualifications, preferences, vocabulary.
   *
   * Distinct from customInstructions (rules for how to behave) and skills
   * (procedures for one capability). Rendered into every planning prompt, so
   * bounded by MAX_CONTEXT_ENTRIES in convex/lib/userContext.ts.
   */
  userContext: defineTable({
    userId: v.id("users"),
    category: v.string(), // see CONTEXT_CATEGORIES
    text: v.string(),
  }).index("by_user_category", ["userId", "category"]),
```

**Verify:** the `convex dev` terminal pushes without error.

---

## Step 4 — Reads and writes

**File:** `convex/model/userContext.ts` **(create)**

```ts
import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { MAX_CONTEXT_ENTRIES, MAX_ENTRY_CHARS } from "../lib/userContext";

export const add = internalMutation({
  args: { userId: v.id("users"), category: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const text = args.text.trim().slice(0, MAX_ENTRY_CHARS);
    if (!text) throw new Error("empty context entry");

    const existing = await ctx.db
      .query("userContext")
      .withIndex("by_user_category", (q) => q.eq("userId", args.userId))
      .take(MAX_CONTEXT_ENTRIES + 1);

    // Near-duplicate guard: re-stating a fact should update, not accumulate.
    // Without this, "I'm a frontend engineer" said three times over three
    // weeks becomes three rows that all render on every message.
    const duplicate = existing.find(
      (e) => e.text.trim().toLowerCase() === text.toLowerCase(),
    );
    if (duplicate) return { contextId: duplicate._id, created: false, text };

    if (existing.length >= MAX_CONTEXT_ENTRIES) {
      throw new Error(
        `You have ${existing.length} context entries, the max is ${MAX_CONTEXT_ENTRIES}. ` +
          `Remove one before adding another.`,
      );
    }

    const contextId = await ctx.db.insert("userContext", {
      userId: args.userId,
      category: args.category,
      text,
    });
    return { contextId, created: true, text };
  },
});

export const list = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userContext")
      .withIndex("by_user_category", (q) => q.eq("userId", args.userId))
      .take(MAX_CONTEXT_ENTRIES);
  },
});

/** Same id-or-fragment pattern as tasks.findByTitle and
 *  instructions.findByFragment — the user says "forget the React thing",
 *  not an id. */
export const findByFragment = internalQuery({
  args: { userId: v.id("users"), fragment: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("userContext")
      .withIndex("by_user_category", (q) => q.eq("userId", args.userId))
      .take(MAX_CONTEXT_ENTRIES);

    const needle = args.fragment.trim().toLowerCase();
    return all.find((e) => e.text.toLowerCase().includes(needle)) ?? null;
  },
});

export const remove = internalMutation({
  args: { userId: v.id("users"), contextId: v.id("userContext") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("userContext", args.contextId);
    if (!row || row.userId !== args.userId) return { removed: false };
    await ctx.db.delete("userContext", args.contextId);
    return { removed: true, text: row.text };
  },
});
```

**Verify:** `bunx convex codegen && bun run typecheck` — clean.

---

## Step 5 — The tool contract

**File:** `convex/lib/tools/catalog.ts` **(edit)**

Add to `TOOL_SCHEMAS`:

```ts
  "context.set": z.object({
    category: z
      .string()
      .optional()
      .describe(
        "profile | preferences | working_style | domain | relationships | other — anything unrecognised files as other",
      ),
    text: z
      .string()
      .min(1)
      .describe("one fact about the user, stated plainly, e.g. 'Frontend engineer, mostly React'"),
  }),
  "context.list": z.object({}),
  "context.remove": z
    .object({
      contextId: z.string().optional().describe("id from a context.list result"),
      textFragment: z.string().optional().describe("a snippet of the fact, if you have no id"),
    })
    .refine((v) => Boolean(v.contextId || v.textFragment), {
      message: "give either contextId or textFragment",
    }),
```

And to `TOOL_META`:

```ts
  "context.set": {
    description:
      "Record a lasting FACT about the user — their role, qualifications, " +
      "preferences, vocabulary, or who matters to them. Use when they say " +
      "things like \"I'm a…\", \"I work at…\", \"I prefer…\", \"remember that " +
      "I…\". This is a fact, not an instruction: use instruction.add for a " +
      "rule about how you should behave.",
    consequential: false,
    requiresAccountId: false,
  },
  "context.list": {
    description: "Show everything you know about the user.",
    consequential: false,
    requiresAccountId: false,
  },
  "context.remove": {
    description: "Forget one recorded fact about the user.",
    consequential: false,
    requiresAccountId: false,
  },
```

---

## Step 6 — Dispatch

**File:** `convex/tools/router.ts` **(edit)**

Add three `case`s to `dispatch()`. Note `context.set` echoes `text` back — the mutation returns an id, and `outcomes.ts` needs the content to confirm what was saved. (This exact omission produced an empty `Skill ""` confirmation twice already; it is worth doing right the first time here.)

```ts
    case "context.set": {
      const category = normalizeCategory((a.category as string | undefined) ?? "other");
      return await ctx.runMutation(internal.model.userContext.add, {
        userId,
        category,
        text: a.text as string,
      });
    }

    case "context.list": {
      const rows = await ctx.runQuery(internal.model.userContext.list, { userId });
      return rows.map((r) => ({ contextId: r._id, category: r.category, text: r.text }));
    }

    case "context.remove": {
      let contextId = a.contextId as string | undefined;
      if (!contextId && typeof a.textFragment === "string") {
        const found = await ctx.runQuery(internal.model.userContext.findByFragment, {
          userId,
          fragment: a.textFragment,
        });
        if (!found) return { removed: false };
        contextId = found._id;
      }
      if (!contextId) throw new Error("no contextId or textFragment given");

      return await ctx.runMutation(internal.model.userContext.remove, {
        userId,
        contextId: contextId as Id<"userContext">,
      });
    }
```

Add the import at the top:

```ts
import { normalizeCategory } from "../lib/userContext";
```

---

## Step 7 — Rendering

**File:** `convex/lib/tools/outcomes.ts` **(edit)**

```ts
    case "context.set":
      return field(r, "created") === false
        ? `🧠 Already knew that.`
        : `🧠 Noted: ${str(r, "text") ?? ""}`;

    case "context.list": {
      const rows = Array.isArray(r) ? r : [];
      if (rows.length === 0) return "I don't know anything about you yet.";
      return rows
        .map((x) => `• [${str(x, "category") ?? "other"}] ${str(x, "text") ?? ""}`)
        .join("\n");
    }

    case "context.remove":
      return field(r, "removed") === true
        ? `🗑️ Forgotten: ${str(r, "text") ?? ""}`
        : "Couldn't find anything matching that.";
```

---

## Step 8 — Into the prompt

**File:** `convex/lib/prompts/assistant.ts` **(edit)**

**What this does.** Context renders on **every** message, unlike skills — identity is always relevant, a procedure usually isn't. That is why it is bounded, and why the bound has a test.

Add to `PlanningContext`:

```ts
  /** Facts about the owner. Rendered every message — see MAX_CONTEXT_ENTRIES. */
  userContext: { category: string; text: string }[];
```

Render it (import `renderUserContext` from `../userContext`) and place it **above** the tool catalogue — it frames everything below it:

```ts
What you know about ${ctx.displayName}:
${renderUserContext(ctx.userContext as ContextEntry[])}
```

Add to `SCOPE`:

```
Use what you know about the user to tailor every reply — their role, their
vocabulary, how they like to be written to. Do not recite it back at them; it
is background, not content. If they state a new lasting fact about themselves,
record it with context.set. A FACT about them ("I'm a frontend engineer") is
context.set; a RULE for you ("keep replies short") is instruction.add.
```

---

## Step 9 — Assert it reaches the model

**File:** `tests/unit/assistant-prompt.test.ts` **(edit)**

Add `userContext: []` to the shared fixture, then:

```ts
describe("planningSystemPrompt — user context", () => {
  test("says so when nothing is known", () => {
    expect(planningSystemPrompt(base)).toContain("(nothing recorded yet)");
  });

  test("renders known facts, grouped", () => {
    const prompt = planningSystemPrompt({
      ...base,
      userContext: [{ category: "profile", text: "Frontend engineer, React" }],
    });
    expect(prompt).toContain("PROFILE");
    expect(prompt).toContain("Frontend engineer, React");
  });

  test("tells the model the difference between a fact and a rule", () => {
    expect(planningSystemPrompt(base)).toContain("context.set");
    expect(planningSystemPrompt(base)).toContain("instruction.add");
  });
});
```

---

## Step 10 — Load it, and a command to see it

**File:** `convex/assistant.ts` **(edit)**

Add `internal.model.userContext.list` to the `Promise.all` in `converse()`, pass it through as `userContext`, and add a `/context` command mirroring `skillsCommand`:

```ts
    case "/context":
      return await contextCommand(ctx, userId);
```

```ts
async function contextCommand(ctx: ActionCtx, userId: Id<"users">): Promise<string> {
  const rows = await ctx.runQuery(internal.model.userContext.list, { userId });
  return renderOutcomes("", [
    {
      name: "context.list",
      ok: true,
      result: rows.map((r) => ({ contextId: r._id, category: r.category, text: r.text })),
    },
  ]);
}
```

Add `/context — what I know about you` to `/help`.

---

## Done when

- [ ] `bun test` — all pass, including the new `user-context.test.ts`
- [ ] `bun run typecheck` — clean
- [ ] `bunx convex dev --once` — deploys
- [ ] Tell the bot *"I'm a frontend engineer, mostly React and TypeScript"* → it records a fact, and does **not** create a task
- [ ] Tell it *"keep your replies short"* → it uses `instruction.add`, **not** `context.set` (the fact/rule distinction holds)
- [ ] `/context` lists what it knows, grouped by category
- [ ] Say *"forget the React thing"* → removed, by fragment, no id needed
- [ ] Repeat the same fact twice → one row, not two (`created: false` the second time)
- [ ] Ask something domain-flavoured and confirm the reply is tailored — this is the actual point, and the only check a test can't make for you

```bash
git add -A && git commit -m "Phase 2B: user context — persistent facts that tailor every reply"
```

---

## What each file does, one line each

| File | Responsibility |
|---|---|
| `convex/lib/userContext.ts` | Categories, bounds, and the exact prompt fragment. Pure. |
| `convex/model/userContext.ts` | The only reads and writes; duplicate and cap enforcement. |
| `convex/lib/tools/catalog.ts` | The three tools' argument contracts. |
| `convex/tools/router.ts` | Executes them; resolves "forget the X thing" to a row in code. |
| `convex/lib/tools/outcomes.ts` | Turns their results into the sentence the user reads. |
| `convex/lib/prompts/assistant.ts` | Puts identity above the tool catalogue, every message. |
| `convex/assistant.ts` | Loads it into `converse()`; `/context`. |
| `convex/schema.ts` | The `userContext` table. |

---

## Next

**Phase 21 — Meeting transcripts.** The first feature that genuinely needs this one: *"a TL;DR for me, not for the meeting"* is undefined until the system knows who "me" is and what you care about. Build 2B first, then 21 reads it.

Phase 4's classifier is the other beneficiary — knowing your role and what you're working on is most of what separates "important" from "noise", and it currently has none of that.
