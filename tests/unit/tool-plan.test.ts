import { describe, expect, test } from "bun:test";
import { parseToolPlan } from "../../convex/lib/tools/plan";
import { describeCatalog, TOOL_NAMES, TOOL_META, HIDDEN_FROM_PLANNER } from "../../convex/lib/tools/catalog";

describe("parseToolPlan", () => {
  test("parses a clean plan", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "Done.",
        tools: [{ name: "task.create", args: { title: "Test the server" } }],
      }),
    );
    expect(plan.reply).toBe("Done.");
    expect(plan.calls).toEqual([
      { name: "task.create", args: { title: "Test the server" } },
    ]);
    expect(plan.rejected).toEqual([]);
  });

  test("unwraps a fenced code block", () => {
    const plan = parseToolPlan('```json\n{"reply":"ok","tools":[]}\n```');
    expect(plan.reply).toBe("ok");
    expect(plan.calls).toEqual([]);
  });

  test("survives prose before the JSON", () => {
    const plan = parseToolPlan('Sure! {"reply":"ok","tools":[]}');
    expect(plan.reply).toBe("ok");
  });

  test("a brace inside the reply string does not truncate the object", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "use { like this }", tools: [] }),
    );
    expect(plan.reply).toBe("use { like this }");
  });

  test("plain prose becomes the reply with no tools", () => {
    const plan = parseToolPlan("I cannot do that yet.");
    expect(plan.reply).toBe("I cannot do that yet.");
    expect(plan.calls).toEqual([]);
  });

  test("an unknown tool is rejected, not executed", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "email.send", args: {} }] }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]).toMatchObject({ name: "email.send", reason: "unknown tool" });
  });

  test("invalid arguments are rejected with a reason", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "task.create", args: { title: "" } }] }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.name).toBe("task.create");
    expect(plan.rejected[0]?.reason).toContain("title");
  });

  test("prompt injection in an untrusted field cannot invent a tool", () => {
    // The structural defence: there is no tool that sends anything in Phase 2,
    // so a proposal to send is unrepresentable, not merely discouraged.
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "ok",
        tools: [
          { name: "task.create", args: { title: "legit" } },
          { name: "shell.exec", args: { cmd: "rm -rf /" } },
        ],
      }),
    );
    expect(plan.calls.map((c) => c.name)).toEqual(["task.create"]);
    expect(plan.rejected.map((r) => r.name)).toEqual(["shell.exec"]);
  });
});

describe("catalog", () => {
  test("every tool has metadata", () => {
    for (const name of TOOL_NAMES) expect(TOOL_META[name]).toBeDefined();
  });

  test("the consequential set is exactly what it should be", () => {
    // Deliberately an EQUALITY assertion, not a count. A consequential tool
    // is one that reaches outside the deployment or destroys something, and
    // adding one must be a decision someone made on purpose — this test is
    // the place that decision gets recorded.
    //
    // email.send_reply       — sends mail to another person.
    // linear.apply_changeset  — writes to a shared issue tracker.
    // calendar.apply_event    — emails an invitation and lands on someone
    //                           else's calendar. Note that its sibling,
    //                           calendar.create_event, is NOT here: a solo
    //                           block affects nobody, so it writes freely and
    //                           only escalates to this tool when there are
    //                           guests. Consequentiality is about attendees,
    //                           not about writing.
    // capture.apply           — writes a BATCH the user was shown. A single
    //                           note.save is not consequential; ten items
    //                           pulled off a possibly-misread carousel are,
    //                           because the damage scales and the user cannot
    //                           spot it afterwards. Its sibling
    //                           capture.propose only shows the list.
    const consequential = Object.entries(TOOL_META)
      .filter(([, meta]) => meta.consequential)
      .map(([name]) => name)
      .sort();

    expect(consequential).toEqual([
      "calendar.apply_event",
      "capture.apply",
      "email.send_reply",
      "linear.apply_changeset",
    ]);
  });

  test("capture.propose is NOT consequential — showing a list writes nothing", () => {
    expect(TOOL_META["capture.propose"].consequential).toBe(false);
    expect(TOOL_META["capture.apply"].consequential).toBe(true);
  });

  test("calendar.create_event is NOT consequential — the guest list decides", () => {
    // If this ever flips to true, blocking your own focus time starts
    // demanding a tap, and the tool stops being worth using.
    expect(TOOL_META["calendar.create_event"].consequential).toBe(false);
    expect(TOOL_META["calendar.apply_event"].consequential).toBe(true);
  });

  test("no tool that merely READS is marked consequential", () => {
    for (const [name, meta] of Object.entries(TOOL_META)) {
      const reads = /\.(list|get|search|read|preview|find)/.test(name);
      if (reads) expect(`${name}:${meta.consequential}`).toBe(`${name}:false`);
    }
  });

  test("no tool that permanently destroys anything exists", () => {
    // Invariant from the source plan: email.delete_permanently NEVER EXISTS.
    for (const name of TOOL_NAMES) {
      expect(name).not.toContain("delete_permanently");
      expect(name).not.toContain("destroy");
    }
  });

  test("the rendered catalog names every tool except the deliberately hidden ones", () => {
    const rendered = describeCatalog();
    for (const name of TOOL_NAMES) {
      if (HIDDEN_FROM_PLANNER.has(name)) expect(rendered).not.toContain(`- ${name}(`);
      else expect(rendered).toContain(name);
    }
  });

  test("required and optional arguments render distinctly", () => {
    expect(describeCatalog()).toContain("task.create(title:");
    expect(describeCatalog()).toContain("detail?:");
  });

  test("every argument carries a type or an example", () => {
    // The regression this guards: the catalogue once listed field NAMES only,
    // so the model guessed `priority: "high"` against a bare z.number() and
    // the call was silently discarded.
    const rendered = describeCatalog();
    expect(rendered).toContain("ACTIVE|PAUSED|DONE");
    expect(rendered).toContain("CRITICAL|HIGH|NORMAL|LOW");
    expect(rendered).toContain("ISO 8601 local time");
  });
});

describe("argument coercion — what a model actually emits", () => {
  test('priority "high" is accepted, not rejected', () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [
          { name: "memory.upsert_project", args: { name: "Momentum Logistics", priority: "high" } },
        ],
      }),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.calls[0]?.args).toEqual({ name: "Momentum Logistics", priority: 2 });
  });

  test("priority as a numeric string is accepted", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "task.create", args: { title: "X", priority: "2" } }],
      }),
    );
    expect(plan.calls[0]?.args.priority).toBe(2);
  });

  test("lower-case and hyphenated enums are normalised", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [
          { name: "task.update", args: { taskId: "t1", status: "in-progress" } },
          { name: "memory.upsert_project", args: { name: "P", status: "active" } },
          { name: "person.upsert", args: { displayName: "Dash", importance: "high" } },
        ],
      }),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.calls[0]?.args.status).toBe("IN_PROGRESS");
    expect(plan.calls[1]?.args.status).toBe("ACTIVE");
    expect(plan.calls[2]?.args.importance).toBe("HIGH");
  });

  test("a task can be addressed by title when no id exists yet", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [
          { name: "task.create", args: { title: "Test the server" } },
          {
            name: "task.block",
            args: { taskTitle: "Test the server", description: "waiting on Dash for the OTP" },
          },
        ],
      }),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.calls).toHaveLength(2);
  });

  test("a task reference with NEITHER id nor title is still rejected", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "task.complete", args: {} }],
      }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.reason).toContain("taskId or taskTitle");
  });

  test("genuine nonsense is still rejected", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "task.create", args: { title: "X", priority: "banana" } }],
      }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.name).toBe("task.create");
  });
});

describe("catalog — Phase 3 tools", () => {
  test("account.connect_link needs no arguments", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "account.connect_link", args: {} }] }),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.calls[0]?.name).toBe("account.connect_link");
  });

  test("email.get_message requires an id", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "email.get_message", args: {} }] }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.name).toBe("email.get_message");
  });

  test("none of the new tools are consequential (still Phase 3, still read-only)", () => {
    expect(TOOL_META["account.connect_link"].consequential).toBe(false);
    expect(TOOL_META["email.list_recent"].consequential).toBe(false);
    expect(TOOL_META["email.search"].consequential).toBe(false);
    expect(TOOL_META["email.get_message"].consequential).toBe(false);
  });
});

describe("catalog — Gmail label filter", () => {
  test('a spam request coerces "spam" to the enum', () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "email.list_recent", args: { gmailLabel: "spam" } }],
      }),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.calls[0]?.args.gmailLabel).toBe("SPAM");
  });

  test("email.search no longer requires a keyword — label-only filtering works", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "email.search", args: { gmailLabel: "SPAM" } }],
      }),
    );
    expect(plan.rejected).toEqual([]);
  });
});

describe("catalog — instruction tools", () => {
  test("instruction.add requires text", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "instruction.add", args: {} }] }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.name).toBe("instruction.add");
  });

  test("instruction.remove needs an id or a fragment", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "instruction.remove", args: {} }] }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.reason).toContain("instructionId or textFragment");
  });

  test("none of the instruction tools are consequential", () => {
    expect(TOOL_META["instruction.add"].consequential).toBe(false);
    expect(TOOL_META["instruction.remove"].consequential).toBe(false);
  });
});

describe("catalog — email search windows", () => {
  test("email.search accepts a widening window", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [
          { name: "email.search", args: { from: "paul", withinDays: 30, afterDays: 14 } },
        ],
      }),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.calls[0]?.args.withinDays).toBe(30);
    expect(plan.calls[0]?.args.afterDays).toBe(14);
    expect(plan.calls[0]?.args.from).toBe("paul");
  });

  test("a label alone is criteria enough", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "email.search", args: { gmailLabel: "SPAM", withinDays: 365 } }],
      }),
    );
    expect(plan.rejected).toEqual([]);
  });

  test("a search with NO criteria is rejected, not run against the whole mailbox", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "email.search", args: { withinDays: 365 } }],
      }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.name).toBe("email.search");
  });

  test("email.list_recent still needs no criteria — it is the 'what is new' tool", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "email.list_recent", args: {} }] }),
    );
    expect(plan.rejected).toEqual([]);
  });
});

describe("catalog — email.get_message by fragment", () => {
  test("accepts senderOrSubject with no id", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "email.get_message", args: { senderOrSubject: "FairMoney" } }],
      }),
    );
    expect(plan.rejected).toEqual([]);
  });
  test("still rejects when neither id nor fragment is given", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "email.get_message", args: {} }] }),
    );
    expect(plan.calls).toEqual([]);
  });
});

describe("catalog — skill tools", () => {
  test("skill.update requires name/title/content", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "skill.update", args: { name: "x" } }] }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.name).toBe("skill.update");
  });
  test("a full skill.update call is accepted", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [
          {
            name: "skill.update",
            args: { name: "check_email", title: "Check email", content: "Step 1..." },
          },
        ],
      }),
    );
    expect(plan.rejected).toEqual([]);
  });
  test("none of the skill tools are consequential", () => {
    expect(TOOL_META["skill.update"].consequential).toBe(false);
    expect(TOOL_META["skill.list"].consequential).toBe(false);
    expect(TOOL_META["skill.get"].consequential).toBe(false);
  });
});

describe("catalog — user context tools", () => {
  test("context.set requires text", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "context.set", args: {} }] }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.name).toBe("context.set");
  });

  test("context.set accepts a bare fact with no category", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "context.set", args: { text: "Frontend engineer" } }],
      }),
    );
    expect(plan.rejected).toEqual([]);
  });

  test("context.remove needs an id or a fragment", () => {
    const plan = parseToolPlan(
      JSON.stringify({ reply: "", tools: [{ name: "context.remove", args: {} }] }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.reason).toContain("contextId or textFragment");
  });

  test("none of the context tools are consequential", () => {
    expect(TOOL_META["context.set"].consequential).toBe(false);
    expect(TOOL_META["context.list"].consequential).toBe(false);
    expect(TOOL_META["context.remove"].consequential).toBe(false);
  });
});

describe("parseToolPlan — malformed JSON recovery", () => {
  test("recovers a doubled-brace object instead of printing it as prose", () => {
    // Observed live: the model emitted {{ "reply": ..., "tools": [...] }},
    // so the removal it proposed never ran and the raw JSON was shown to the
    // user as the answer.
    const plan = parseToolPlan(
      '{{ "reply": "Done.", "tools": [ { "name": "context.remove", "args": { "textFragment": "computer science" } } ] }}',
    );
    expect(plan.reply).toBe("Done.");
    expect(plan.calls[0]?.name).toBe("context.remove");
  });

  test("genuinely broken JSON still falls back to prose", () => {
    const plan = parseToolPlan("{ this is not json at all");
    expect(plan.calls).toEqual([]);
  });
});

describe("catalog — email.create_draft accepts a fragment", () => {
  test("a fragment with no id is accepted", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [
          {
            name: "email.create_draft",
            args: { senderOrSubject: "FairMoney", talkingPoints: "thanks, noted" },
          },
        ],
      }),
    );
    expect(plan.rejected).toEqual([]);
  });

  test("neither id nor fragment is still rejected", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "email.create_draft", args: { talkingPoints: "hi" } }],
      }),
    );
    expect(plan.calls).toEqual([]);
    expect(plan.rejected[0]?.reason).toContain("emailMessageId or senderOrSubject");
  });
});

describe("catalog — capture.propose accepts the shapes the model actually sends", () => {
  const plan = (items: unknown) =>
    parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [
          {
            name: "capture.propose",
            args: { title: "Movies", destination: "notes", items },
          },
        ],
      }),
    );

  test("the documented object form works", () => {
    const p = plan([{ title: "Arrival", detail: "2016" }]);
    expect(p.rejected).toEqual([]);
    expect(p.calls[0]?.args.items).toEqual([{ title: "Arrival", detail: "2016" }]);
  });

  test("a bare array of strings is accepted, not rejected", () => {
    // Measured live: asked for five films the model sent plain strings. A
    // correct answer in the wrong shape must not become zero items.
    const p = plan(["Arrival (2016)", "Dune (2021)"]);
    expect(p.rejected).toEqual([]);
    expect(p.calls[0]?.args.items).toEqual([
      { title: "Arrival (2016)" },
      { title: "Dune (2021)" },
    ]);
  });

  test("`name` and `text` are accepted as the title key", () => {
    expect(plan([{ name: "Dune" }]).calls[0]?.args.items).toEqual([{ title: "Dune" }]);
    expect(plan([{ text: "Dune" }]).calls[0]?.args.items).toEqual([{ title: "Dune" }]);
  });

  test("`description`, `note` and `year` are accepted as the detail key", () => {
    expect(plan([{ title: "Dune", year: 2021 }]).calls[0]?.args.items).toEqual([
      { title: "Dune", detail: "2021" },
    ]);
    expect(plan([{ title: "Dune", description: "sci-fi" }]).calls[0]?.args.items).toEqual([
      { title: "Dune", detail: "sci-fi" },
    ]);
  });

  test("a mixed array is normalised item by item", () => {
    expect(plan(["Arrival", { title: "Dune", detail: "2021" }]).calls[0]?.args.items).toEqual([
      { title: "Arrival" },
      { title: "Dune", detail: "2021" },
    ]);
  });

  test("genuinely unusable items are still rejected", () => {
    expect(plan([{ nonsense: true }]).rejected.length).toBe(1);
    expect(plan([]).rejected.length).toBe(1);
    expect(plan([""]).rejected.length).toBe(1);
  });

  test("a batch beyond the cap is rejected rather than silently trimmed", () => {
    expect(plan(Array.from({ length: 31 }, (_, i) => `Item ${i}`)).rejected.length).toBe(1);
  });
});
