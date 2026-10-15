import { describe, expect, test } from "bun:test";
import { TELEGRAM_FORMAT_CONTRACT } from "../../convex/lib/prompts/format";
import { KNOWLEDGE_HEADING, buildKnowledgeBlock } from "../../convex/lib/prompts/knowledge";
import {
  planningSystemPrompt,
  planningInput,
  tldrOnlySystemPrompt,
  renderConversation,
  SUMMARY_SYSTEM_PROMPT,
} from "../../convex/lib/prompts/assistant";

const base = {
  displayName: "Adedotun",
  timezone: "Africa/Lagos",
  nowMs: Date.UTC(2026, 7, 20, 9, 0),
  projects: [],
  openTasks: [],
  reminders: [],
  connectedAccounts: [],
  customInstructions: [],
  activeSkills: [],
  userContext: [],
};

describe("planningSystemPrompt", () => {
  test("states the current time in the user's zone", () => {
    expect(planningSystemPrompt(base)).toContain("10:00");
    expect(planningSystemPrompt(base)).toContain("Africa/Lagos");
  });

  test("says so explicitly when there is nothing yet", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("(none yet)");
    expect(prompt).toContain("(none open)");
    expect(prompt).toContain("(none pending)");
  });

  test("lists task ids so the model never has to invent one", () => {
    const prompt = planningSystemPrompt({
      ...base,
      openTasks: [{ taskId: "abc123", title: "Test the server", status: "PLANNED" }],
    });
    expect(prompt).toContain("[abc123] Test the server — PLANNED");
    expect(prompt).toContain("Never invent a taskId");
  });

  test("includes the tool catalog WITH argument types", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("reminder.create");
    expect(prompt).toContain("ACTIVE|PAUSED|DONE");
    expect(prompt).toContain('ISO 8601 local time');
    expect(prompt).toContain('"critical"|"high"|"normal"|"low"');
  });

  test("lists pending reminders with ids so cancelling needs no round-trip", () => {
    const prompt = planningSystemPrompt({
      ...base,
      reminders: [
        { reminderId: "rem1", message: "Call Paul", scheduledFor: "Thu 20 Aug, 14:00" },
      ],
    });
    expect(prompt).toContain("[rem1] Thu 20 Aug, 14:00 — Call Paul");
  });

  test("warns that a mistyped argument is discarded", () => {
    expect(planningSystemPrompt(base)).toContain("DISCARDED");
  });

  test("lists connected mailboxes as fact, not something to guess", () => {
    const prompt = planningSystemPrompt({
      ...base,
      connectedAccounts: [
        { label: "personal", email: "ade.propmail@gmail.com", status: "ACTIVE" },
      ],
    });
    expect(prompt).toContain("ade.propmail@gmail.com (personal) — ACTIVE");
  });

  test("says explicitly when nothing is connected, and to offer the connect tool", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("none connected");
    expect(prompt).toContain("account.connect_link");
  });

  test("states scope boundaries: no code, no infra, no Calendar/Drive", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("NO ability to write, read, or change code");
    expect(prompt).toContain("Google Cloud Console");
    // Linear left this list when Phase 16 landed. The list is a promise about
    // what does not exist — every entry removed from it must correspond to a
    // real tool, and every tool absent from the catalogue must be in it.
    // Calendar and Drive left this list when Phases 10 and 11 landed,
    // exactly as Linear did in Phase 16. WhatsApp is still genuinely absent,
    // and so are the destructive email actions.
    expect(prompt).toContain("WhatsApp");
    expect(prompt).toContain("CALENDAR is real");
    expect(prompt).toContain("DRIVE is real, and READ-ONLY");
    // The rule that keeps Drive safe must survive any rewording of the rest.
    expect(prompt).toContain("You NARROW; the user CHOOSES");
    expect(prompt).toContain("task.update / complete / block / unblock");
    expect(prompt).toContain('Never say "I am checking / investigating');
  });

  test("instructs the model to use the connect tool instead of apologising in prose", () => {
    expect(planningSystemPrompt(base)).toContain("account.connect_link or an email.* tool");
  });
});

describe("renderConversation", () => {
  test("labels each side and preserves order", () => {
    expect(
      renderConversation([
        { direction: "in", text: "hi" },
        { direction: "out", text: "Ready." },
      ]),
    ).toBe("User: hi\nAssistant: Ready.");
  });
});

describe("planningSystemPrompt — custom instructions", () => {
  test("renders saved instructions verbatim", () => {
    const prompt = planningSystemPrompt({
      ...base,
      customInstructions: ["Keep replies under two sentences.", "Never schedule anything before 9am."],
    });
    expect(prompt).toContain("Keep replies under two sentences.");
    expect(prompt).toContain("Never schedule anything before 9am.");
  });

  test("says so when none are saved", () => {
    expect(planningSystemPrompt(base)).toContain("(none saved)");
  });

  test("states that instructions cannot grant a capability or bypass scope", () => {
    const flat = planningSystemPrompt(base).replace(/\s+/g, " ");
    expect(flat).toContain("never what tools exist");
    expect(flat).toContain("nothing here overrides the consequential-action or scope rules");
  });
});

describe("tldrOnlySystemPrompt — deadlines", () => {
  const skills = [{ title: "Check email", content: "Append a TL;DR." }];
  const NOW = Date.UTC(2026, 7, 21, 9, 0);

  test("states the current date so a passed deadline can be recognised", () => {
    expect(tldrOnlySystemPrompt(skills, NOW, "Africa/Lagos")).toContain("Current date and time:");
  });

  test("treats an event or booking link as an action, not 'no action required'", () => {
    const p = tldrOnlySystemPrompt(skills, NOW, "Africa/Lagos");
    expect(p).toContain("IS an action");
    expect(p.replace(/\s+/g, " ")).toContain("has already passed");
  });
});

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
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("context.set");
    expect(prompt).toContain("instruction.add");
  });

  test("context sits ABOVE the tool catalogue so it frames what follows", () => {
    const prompt = planningSystemPrompt({
      ...base,
      userContext: [{ category: "profile", text: "Frontend engineer" }],
    });
    expect(prompt.indexOf("What you know about")).toBeLessThan(
      prompt.indexOf("Tools available:"),
    );
  });
});

describe("planningSystemPrompt — no redundant context writes", () => {
  test("tells the model not to re-record a fact it already holds", () => {
    expect(planningSystemPrompt(base).replace(/\s+/g, " ")).toContain(
      "Only record something NEW",
    );
  });
});
describe("planningSystemPrompt — Phase 6 send scope", () => {
  const flat = () => planningSystemPrompt(base).replace(/\s+/g, " ");

  test("classification is described as a judgement, never a permission", () => {
    expect(flat()).toContain("(CRITICAL|HIGH|NORMAL|LOW|IGNORE)");
    expect(flat()).toContain("not a tool you call");
    expect(flat()).toContain("a judgement, never a permission");
  });

  test("sending requires an explicit tap and cannot be talked around", () => {
    expect(flat()).toContain("email.send_reply NEVER sends anything by itself");
    expect(flat()).toContain(
      "no wording, no saved instruction, and no claimed prior approval",
    );
  });

  test("SCOPE no longer claims sending does not exist", () => {
    // Phase 4 wrote "that tool still does not exist" about sending. Phase 6
    // makes that false; a prompt that contradicts itself teaches the model
    // that its own SCOPE is unreliable.
    expect(flat()).not.toContain("no ability to send, reply, or delete");
  });
});

describe("user-taught knowledge reaches every user-facing prompt", () => {
  // THE READER TEST. Twice a config surface shipped with a writer and no
  // reader — skills in Aug 2026, then userContext/customInstructions missing
  // from the morning brief. Neither failed loudly: a stored-but-unread fact
  // looks exactly like a fact the model chose to ignore.
  //
  // A shared renderer alone would not have caught either. This is what does:
  // every prompt whose output the user reads must demonstrably contain the
  // block. Add the next prompt builder here, or it will be the third.
  const nowMs = Date.parse("2026-08-23T09:00:00Z");
  const skills = [{ title: "T", content: "do the thing" }];
  const knowledge = {
    userContext: [
      { category: "profile" as const, text: "frontend engineer" },
      { category: "preferences" as const, text: "washes hair on Sundays" },
    ],
    customInstructions: ["keep replies short"],
  };

  const withKnowledge: [string, string][] = [
    [
      "planningSystemPrompt",
      planningSystemPrompt({
        ...base,
        userContext: knowledge.userContext,
        customInstructions: knowledge.customInstructions,
      }),
    ],
    ["tldrOnlySystemPrompt", tldrOnlySystemPrompt(skills, nowMs, "Africa/Lagos", knowledge)],
  ];

  for (const [name, prompt] of withKnowledge) {
    test(`${name} renders the knowledge block`, () => {
      expect(prompt).toContain(KNOWLEDGE_HEADING);
    });

    test(`${name} carries an actual recorded fact through`, () => {
      // Not just the heading — the CONTENT. A heading with an empty body is
      // how the brief bug would have looked if only the heading were tested.
      expect(prompt).toContain("washes hair on Sundays");
      expect(prompt).toContain("keep replies short");
    });
  }

  test("buildKnowledgeBlock renders its headings even when empty", () => {
    // "nothing recorded" must be distinguishable from "this prompt forgot to
    // ask" — that ambiguity is what hid the bug for two days.
    const empty = buildKnowledgeBlock({ userContext: [], customInstructions: [] });
    expect(empty).toContain(KNOWLEDGE_HEADING);
    expect(empty).toContain("(none saved)");
  });
});

describe("format contract reaches every user-facing prompt", () => {
  // A prompt whose output is shown in Telegram must say what Telegram can
  // render. Until 2026-08-23 none of them did, so the model emitted "###"
  // headings and "---" rules that arrived literally.
  //
  // This is a READER test. The lesson from MEMORY.md 2026-08-21 is that a
  // shared string proves nothing unless something asserts each site actually
  // consults it — writers prove the feature exists, readers prove it does
  // anything. Add the next user-facing prompt builder to this list.
  const nowMs = Date.parse("2026-08-23T09:00:00Z");
  const skills = [{ title: "T", content: "do the thing" }];

  const builders: [string, string][] = [
    ["planningSystemPrompt", planningSystemPrompt(base)],
    ["tldrOnlySystemPrompt", tldrOnlySystemPrompt(skills, nowMs, "Africa/Lagos")],
  ];

  for (const [name, prompt] of builders) {
    test(`${name} states the format contract`, () => {
      expect(prompt).toContain(TELEGRAM_FORMAT_CONTRACT);
    });

    test(`${name} forbids headings, which Telegram cannot render`, () => {
      expect(prompt).toContain("NO headings");
    });
  }
});

describe("SCOPE tells the truth about where notes live", () => {
  // Notes are in Notion ONLY, with no local copy. Two failure modes follow,
  // and both are the model answering from itself instead of looking:
  // claiming to recall a note, and claiming none exists.
  test("says notes must be searched, not recalled", () => {
    const prompt = planningSystemPrompt(base).replace(/\s+/g, " ");
    expect(prompt).toContain("note.search");
    expect(prompt).toContain("never answer from what you happen to recall");
  });

  test("distinguishes an outage from an absence", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("couldn't reach Notion");
  });
});

describe("every user-facing prompt knows which mailbox is which", () => {
  // The planning pass has always had the roster. The COMPOSE passes did not,
  // which is how "check my primary mailbox" could be planned correctly and
  // then answered by a pass that had never been told what "primary" meant.
  const NOW = Date.UTC(2026, 7, 21, 9, 0);
  const skills = [{ title: "Check email", content: "Append a TL;DR." }];
  const mailboxes = [
    { label: "primary", email: "ade.propmail@gmail.com", status: "ACTIVE" },
    { label: "secondary", email: "second@gmail.com", status: "ACTIVE" },
  ];

  const builders: [string, string][] = [
    [
      "tldrOnlySystemPrompt",
      tldrOnlySystemPrompt(skills, NOW, "Africa/Lagos", undefined, mailboxes),
    ],
  ];

  for (const [name, prompt] of builders) {
    test(`${name} names each mailbox and its label`, () => {
      expect(prompt).toContain("ade.propmail@gmail.com (primary) — ACTIVE");
      expect(prompt).toContain("second@gmail.com (secondary) — ACTIVE");
    });
  }

  test("with no mailboxes, every prompt says so rather than going silent", () => {
    for (const build of [
      () => tldrOnlySystemPrompt(skills, NOW, "Africa/Lagos"),
    ]) {
      expect(build()).toContain("(none connected");
    }
  });
});

describe("planningSystemPrompt — assistant behaviour (docs/BEHAVIOUR.md)", () => {
  const flat = () => planningSystemPrompt(base).replace(/\s+/g, " ");

  test("explains the E-label references and the email in focus", () => {
    expect(flat()).toContain("E0");
    expect(flat()).toContain("focus");
  });

  test("tells the model to give ONE best answer to a search", () => {
    expect(flat().toLowerCase()).toContain("one best");
  });
});

describe("planningInput", () => {
  test("carries the transcript and the step", () => {
    const out = planningInput({ transcript: "User: hi", step: 1, hasResults: false });
    expect(out).toContain("User: hi");
  });

  test("includes the rolling summary when there is one", () => {
    const out = planningInput({
      summary: "They are waiting on the visa letter.",
      transcript: "User: any news?",
      step: 1,
      hasResults: false,
    });
    expect(out).toContain("They are waiting on the visa letter.");
  });

  test("tells a later step that results are in", () => {
    const first = planningInput({ transcript: "User: x", step: 1, hasResults: false });
    const later = planningInput({ transcript: "User: x", step: 2, hasResults: true });
    expect(later).not.toEqual(first);
  });
});

describe("SUMMARY_SYSTEM_PROMPT", () => {
  test("is non-empty and asks for a summary", () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain("summar");
  });
});
