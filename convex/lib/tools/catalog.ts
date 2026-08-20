// Pure. The tool contract: name, description, argument schema, and whether
// executing it is consequential. No ctx, no I/O — the executor lives in
// convex/tools/router.ts and is the only thing that touches the database.
import { z } from "zod";

/**
 * Every field carries a `.describe()`, and `describeCatalog()` renders it into
 * the prompt.
 *
 * This is not documentation for humans. Before it existed the model was shown
 * field NAMES only — `memory.upsert_project(name, status?, priority?)` — so
 * "Momentum Logistics is high priority" produced `priority: "high"`, which a
 * bare `z.number()` rejected. The rejection was silent and the assistant
 * cheerfully reported success. Types in the prompt are load-bearing.
 */

/** Lower is more urgent. Words are what people say; numbers are what we store. */
const PRIORITY_WORDS: Record<string, number> = {
  critical: 1, urgent: 1, highest: 1, top: 1,
  high: 2, important: 2,
  normal: 3, medium: 3, moderate: 3, default: 3,
  low: 4, minor: 4,
  lowest: 5, someday: 5,
};

/**
 * Accept what a model actually emits. A schema that only accepts the canonical
 * form turns a phrasing difference into a silently dropped action.
 */
const PRIORITY = z
  .preprocess((value) => {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return value;
    const asNumber = Number(value.trim());
    if (!Number.isNaN(asNumber)) return asNumber;
    return PRIORITY_WORDS[value.trim().toLowerCase()] ?? value;
  }, z.number().int().min(1).max(5))
  .describe('1=critical … 5=lowest, or the words "critical"|"high"|"normal"|"low"');

/** Upper-case, underscore-joined, whatever case the model chose. */
const normalizeEnum = (value: unknown) =>
  typeof value === "string" ? value.trim().toUpperCase().replace(/[\s-]+/g, "_") : value;

const TASK_STATUS = z
  .preprocess(
    normalizeEnum,
    z.enum([
      "PLANNED",
      "IN_PROGRESS",
      "BLOCKED",
      "WAITING",
      "RESUMED",
      "COMPLETED",
      "CANCELLED",
    ]),
  )
  .describe("PLANNED|IN_PROGRESS|BLOCKED|WAITING|RESUMED|COMPLETED|CANCELLED");

const PROJECT_STATUS = z
  .preprocess(normalizeEnum, z.enum(["ACTIVE", "PAUSED", "DONE"]))
  .describe("ACTIVE|PAUSED|DONE");

const IMPORTANCE = z
  .preprocess(normalizeEnum, z.enum(["CRITICAL", "HIGH", "NORMAL", "LOW"]))
  .describe("CRITICAL|HIGH|NORMAL|LOW");

const INSTANT = z
  .string()
  .describe('ISO 8601 local time, e.g. "2026-08-21T10:00"');

/**
 * Gmail's OWN label, not an importance judgement. This is what makes "show me
 * spam" actually filter instead of falling back to "recent" — Phase 3 stores
 * labelIds deterministically; it does not classify anything (that's Phase 4).
 */
const EMAIL_LABEL = z
  .preprocess(normalizeEnum, z.enum([
    "SPAM",
    "INBOX",
    "UNREAD",
    "STARRED",
    "IMPORTANT",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_SOCIAL",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
    "CATEGORY_PERSONAL",
  ]))
  .describe("Gmail's own label, e.g. SPAM — a literal filter, not a judgement call");

/**
 * A task is addressed by id OR by title.
 *
 * Title matters because the model cannot know the id of a task it is creating
 * in the same breath — "I need to test the server, and I'm blocked on Dash"
 * is one message and two calls. The router resolves the title in code, so the
 * model still never supplies a foreign key it invented.
 */
const TASK_REF = {
  taskId: z.string().min(1).optional().describe("id from the open-tasks list above"),
  taskTitle: z
    .string()
    .min(1)
    .optional()
    .describe("title, when you have no id — e.g. a task created earlier in this same plan"),
};

const needsTaskRef = <T extends { taskId?: string; taskTitle?: string }>(value: T) =>
  Boolean(value.taskId || value.taskTitle);
const TASK_REF_ERROR = { message: "give either taskId or taskTitle" };

export const TOOL_SCHEMAS = {
  "memory.upsert_project": z.object({
    name: z.string().min(1).describe("project name"),
    status: PROJECT_STATUS.optional(),
    objective: z.string().optional().describe("what done looks like"),
    priority: PRIORITY.optional(),
  }),
  "memory.get_project": z.object({
    name: z.string().min(1).describe("project name"),
  }),

  "task.create": z.object({
    title: z.string().min(1).describe("short imperative, e.g. 'Test the FedEx response'"),
    detail: z.string().optional().describe("anything that would not fit the title"),
    projectName: z
      .string()
      .optional()
      .describe("project this belongs to; created if new"),
    priority: PRIORITY.optional(),
    dueAt: INSTANT.optional(),
  }),
  "task.list": z.object({
    status: TASK_STATUS.optional(),
    limit: z.number().int().min(1).max(25).optional().describe("default 15"),
  }),
  "task.update": z
    .object({
      ...TASK_REF,
      title: z.string().optional(),
      detail: z.string().optional(),
      status: TASK_STATUS.optional(),
      priority: PRIORITY.optional(),
      dueAt: INSTANT.optional(),
    })
    .refine(needsTaskRef, TASK_REF_ERROR),
  "task.complete": z.object(TASK_REF).refine(needsTaskRef, TASK_REF_ERROR),
  "task.block": z
    .object({
      ...TASK_REF,
      description: z.string().min(1).describe("what it is waiting on"),
      waitingOnPerson: z.string().optional().describe("person's name, if any"),
      expectedAt: INSTANT.optional(),
    })
    .refine(needsTaskRef, TASK_REF_ERROR),
  "task.unblock": z.object(TASK_REF).refine(needsTaskRef, TASK_REF_ERROR),

  "reminder.create": z.object({
    message: z.string().min(1).describe("what to say when it fires"),
    scheduledAt: INSTANT,
  }),
  "reminder.list": z.object({}),
  "reminder.cancel": z.object({
    reminderId: z.string().min(1).describe("id from the pending-reminders list above"),
  }),

  "person.upsert": z.object({
    displayName: z.string().min(1).describe("the person's name"),
    emails: z.array(z.string()).optional(),
    importance: IMPORTANCE.optional(),
    notes: z.string().optional(),
  }),

  "account.connect_link": z.object({
    label: z
      .string()
      .min(1)
      .optional()
      .describe('short tag for this mailbox, e.g. "personal" or "recruiting" — default "personal"'),
  }),

  "email.list_recent": z.object({
    accountLabel: z.string().optional().describe("connected-mailbox label; omit for all"),
    gmailLabel: EMAIL_LABEL.optional(),
    limit: z.number().int().min(1).max(20).optional().describe("default 10"),
    deep: z
      .boolean()
      .optional()
      .describe(
        "true = query Gmail live, no 2-day cap — use when the user says " +
          '"all time"/"everything"/"keep looking", or a normal (non-deep) ' +
          "call just returned empty and they push back",
      ),
  }),
  "email.search": z.object({
    query: z.string().optional().describe("word or phrase to match in subject, sender or body — omit to only filter by gmailLabel"),
    accountLabel: z.string().optional().describe("connected-mailbox label; omit for all"),
    gmailLabel: EMAIL_LABEL.optional(),
    limit: z.number().int().min(1).max(20).optional().describe("default 10"),
    deep: z
      .boolean()
      .optional()
      .describe(
        "true = query Gmail live, no 2-day cap — use when the user says " +
          '"all time"/"everything"/"keep looking", or a normal (non-deep) ' +
          "call just returned empty and they push back",
      ),
  }),
  "email.get_message": z
    .object({
      emailMessageId: z.string().optional().describe("id from an email.list_recent or email.search result"),
      accountLabel: z.string().optional().describe("connected-mailbox label; omit for all"),
      senderOrSubject: z
        .string()
        .optional()
        .describe('a name, address, or subject fragment — e.g. "FairMoney" or "interview" — when you have no id'),
      mode: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          '"summary" (default) when the user asks what an email is about / says / wants; ' +
            '"full" ONLY when they explicitly ask for the full/complete/entire email or to read it all',
        ),
    })
    .refine((v) => Boolean(v.emailMessageId || v.senderOrSubject), {
      message: "give either emailMessageId or senderOrSubject",
    }),

  "instruction.add": z.object({
    text: z
      .string()
      .min(1)
      .describe("a standing rule for how to behave or handle requests going forward"),
  }),
  "instruction.list": z.object({}),
  "instruction.remove": z
    .object({
      instructionId: z.string().optional().describe("id from an instruction.list result"),
      textFragment: z.string().optional().describe("a snippet of the instruction, if you have no id"),
    })
    .refine((v) => Boolean(v.instructionId || v.textFragment), {
      message: "give either instructionId or textFragment",
    }),

  "skill.update": z.object({
    name: z
      .string()
      .min(1)
      .describe('a stable slug for this skill, e.g. "check_email" or "morning_brief"'),
    title: z.string().min(1).describe("short display name"),
    content: z
      .string()
      .min(1)
      .describe(
        "the full procedure, as markdown — may reference another skill with {{skill:name}}",
      ),
  }),
  "skill.list": z.object({}),
  "skill.get": z.object({
    name: z.string().min(1).describe("the skill's slug"),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

interface ToolMeta {
  description: string;
  /** true → requires a typed, expiring, single-use approval (invariant I-4). */
  consequential: boolean;
  /** true → the account must be resolved in code, never inferred (I-3). */
  requiresAccountId: boolean;
}

/**
 * Every Phase 2 tool is `consequential: false` — they touch internal state
 * only, nothing external and nothing destructive to another party. Phase 6's
 * email.send is the first `true`, and the router already refuses to execute
 * one without an approval, so the gate exists before the first tool needs it.
 */
export const TOOL_META: Record<ToolName, ToolMeta> = {
  "memory.upsert_project": {
    description: "Create or update a project. Anything the user calls ongoing work.",
    consequential: false,
    requiresAccountId: false,
  },
  "memory.get_project": {
    description: "Look up one project by name, with its open tasks.",
    consequential: false,
    requiresAccountId: false,
  },
  "task.create": {
    description: "Create a task. Set projectName when the user implies a project.",
    consequential: false,
    requiresAccountId: false,
  },
  "task.list": {
    description: "List tasks, optionally filtered by status.",
    consequential: false,
    requiresAccountId: false,
  },
  "task.update": {
    description: "Change a task's title, detail, status, priority or due date.",
    consequential: false,
    requiresAccountId: false,
  },
  "task.complete": {
    description: "Mark a task COMPLETED.",
    consequential: false,
    requiresAccountId: false,
  },
  "task.block": {
    description: "Mark a task BLOCKED and record what it waits on, and on whom.",
    consequential: false,
    requiresAccountId: false,
  },
  "task.unblock": {
    description: "Resolve a task's blockers and move it to RESUMED.",
    consequential: false,
    requiresAccountId: false,
  },
  "reminder.create": {
    description: "Schedule a Telegram message at an exact time.",
    consequential: false,
    requiresAccountId: false,
  },
  "reminder.list": {
    description: "List pending reminders with their ids.",
    consequential: false,
    requiresAccountId: false,
  },
  "reminder.cancel": {
    description: "Cancel a pending reminder by id.",
    consequential: false,
    requiresAccountId: false,
  },
  "person.upsert": {
    description: "Create or update a person the user mentions.",
    consequential: false,
    requiresAccountId: false,
  },
  "account.connect_link": {
    description:
      "Get a one-time link to connect a Gmail mailbox. Use this whenever the " +
      "user asks to connect, add, or link an email account — do not just " +
      "explain in prose that you cannot access their mail.",
    consequential: false,
    requiresAccountId: false,
  },
  "email.list_recent": {
    description:
      "Recent synced emails (last ~2 days), including spam. Set deep:true to " +
      "query Gmail live with no day limit instead. Read-only.",
    consequential: false,
    requiresAccountId: true,
  },
  "email.search": {
    description:
      "Search synced emails (last ~2 days) by keyword. Set deep:true to query " +
      "Gmail live with no day limit instead — slower, but not capped by sync. " +
      "Read-only.",
    consequential: false,
    requiresAccountId: true,
  },
  "email.get_message": {
    description: "Full detail of one email by id.",
    consequential: false,
    requiresAccountId: true,
  },
  "instruction.add": {
    description:
      "Save a standing behavioural rule the user is teaching you (tone, " +
      "workflow, when to ask first). Use when the user says things like " +
      '"from now on...", "always...", "don\'t...", "remember that...". ' +
      "This tunes HOW you behave — it cannot grant a tool that does not exist.",
    consequential: false,
    requiresAccountId: false,
  },
  "instruction.list": {
    description: "List your saved standing instructions.",
    consequential: false,
    requiresAccountId: false,
  },
  "instruction.remove": {
    description: "Forget a standing instruction.",
    consequential: false,
    requiresAccountId: false,
  },
  "skill.update": {
    description:
      "Create or replace a named skill — a full procedure for how you should " +
      "do something (checking email, a morning brief, drafting a reply). Use " +
      "when the user says things like \"update the X skill\", \"here's how " +
      "you should do X from now on\", or pastes/sends procedural instructions " +
      "for a named capability. Overwrites any prior version of that skill.",
    consequential: false,
    requiresAccountId: false,
  },
  "skill.list": {
    description: "List every skill, and whether the user has customized it.",
    consequential: false,
    requiresAccountId: false,
  },
  "skill.get": {
    description: "Show one skill's full current content.",
    consequential: false,
    requiresAccountId: false,
  },
};

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, name);
}

/** The object shape, past any `.refine()` wrapper. */
function shapeOf(schema: unknown): Record<string, z.ZodType> {
  const inner = (schema as { def?: { type?: string; innerType?: unknown } }).def;
  if (inner?.type === "custom" || inner?.innerType) {
    return shapeOf(inner.innerType ?? schema);
  }
  return ((schema as { shape?: Record<string, z.ZodType> }).shape ?? {});
}

/**
 * `.describe()` lives on whichever node it was called on, and `.optional()`
 * wraps it — so an optional enum reports no description and the model is left
 * guessing the very fields most likely to be guessed wrong. Walk inwards.
 */
function descriptionOf(field: z.ZodType): string | undefined {
  let node: unknown = field;
  for (let depth = 0; depth < 6 && node; depth++) {
    const described = (node as { description?: string }).description;
    if (described) return described;
    node = (node as { def?: { innerType?: unknown; in?: unknown } }).def?.innerType
      ?? (node as { def?: { in?: unknown } }).def?.in;
  }
  return undefined;
}

/**
 * The catalog as the model sees it — names, argument TYPES, and descriptions.
 * The types are the point; see the note at the top of this file.
 */
export function describeCatalog(): string {
  return TOOL_NAMES.map((name) => {
    const args = Object.entries(shapeOf(TOOL_SCHEMAS[name]))
      .map(([key, field]) => {
        const optional = field.safeParse(undefined).success;
        const hint = descriptionOf(field);
        return `${key}${optional ? "?" : ""}${hint ? `: ${hint}` : ""}`;
      })
      .join(", ");
    return `- ${name}(${args})\n    ${TOOL_META[name].description}`;
  }).join("\n");
}
