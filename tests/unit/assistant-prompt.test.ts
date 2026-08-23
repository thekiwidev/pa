import { describe, expect, test } from "bun:test";
import { TELEGRAM_FORMAT_CONTRACT } from "../../convex/lib/prompts/format";
import {
  planningSystemPrompt,
  skillComposeSystemPrompt,
  tldrOnlySystemPrompt,
  renderConversation,
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

  test("states scope boundaries: no code, no infra, no Calendar/Drive/send", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("NO ability to write, read, or change code");
    expect(prompt).toContain("Google Cloud Console");
    expect(prompt).toContain("Calendar, Drive, Linear, WhatsApp");
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

describe("skillComposeSystemPrompt", () => {
  const skills = [{ title: "Check email", content: "Always append a TL;DR." }];
  const NOW = Date.UTC(2026, 7, 21, 9, 0);

  test("embeds the active skill's procedure verbatim", () => {
    const out = skillComposeSystemPrompt("Adedotun", skills, NOW, "Africa/Lagos");
    expect(out).toContain("Always append a TL;DR.");
    expect(out).toContain("Check email");
  });

  test("instructs verbatim copying for full-content, not paraphrase", () => {
    const out = skillComposeSystemPrompt("Adedotun", skills, NOW, "Africa/Lagos");
    expect(out).toContain("COPY THAT TEXT");
    expect(out).toContain("do not paraphrase");
  });

  test("forbids inventing dates/times that are not in the results", () => {
    const out = skillComposeSystemPrompt("Adedotun", skills, NOW, "Africa/Lagos");
    expect(out).toContain("carry it through exactly as written");
  });
});

describe("compose prompts — deadlines and snippets", () => {
  const skills = [{ title: "Check email", content: "Append a TL;DR." }];
  const NOW = Date.UTC(2026, 7, 21, 9, 0);

  test("states the current date so a passed deadline can be recognised", () => {
    expect(skillComposeSystemPrompt("A", skills, NOW, "Africa/Lagos")).toContain("Current date and time:");
    expect(tldrOnlySystemPrompt(skills, NOW, "Africa/Lagos")).toContain("Current date and time:");
  });

  test("treats an event or booking link as an action, not 'no action required'", () => {
    for (const p of [
      skillComposeSystemPrompt("A", skills, NOW, "Africa/Lagos"),
      tldrOnlySystemPrompt(skills, NOW, "Africa/Lagos"),
    ]) {
      expect(p).toContain("IS an action");
      // Wording wraps differently between the two prompts; assert on the
      // concept, not on a phrase that happens to survive a line break.
      expect(p.replace(/\s+/g, " ")).toContain("has already passed");
    }
  });

  test("warns the compose model that snippets truncate", () => {
    const p = skillComposeSystemPrompt("A", skills, NOW, "Africa/Lagos");
    expect(p).toContain("full_email_bodies");
    expect(p.replace(/\s+/g, " ")).toContain("cuts off before the important part");
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
    ["skillComposeSystemPrompt", skillComposeSystemPrompt("Ade", skills, nowMs, "Africa/Lagos")],
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
