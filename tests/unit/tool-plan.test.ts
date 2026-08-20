import { describe, expect, test } from "bun:test";
import { parseToolPlan } from "../../convex/lib/tools/plan";
import { describeCatalog, TOOL_NAMES, TOOL_META } from "../../convex/lib/tools/catalog";

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

  test("no Phase 2 tool is consequential", () => {
    for (const name of TOOL_NAMES) expect(TOOL_META[name].consequential).toBe(false);
  });

  test("the rendered catalog names every tool", () => {
    const rendered = describeCatalog();
    for (const name of TOOL_NAMES) expect(rendered).toContain(name);
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

describe("catalog — deep search", () => {
  test("email.search accepts deep:true", () => {
    const plan = parseToolPlan(
      JSON.stringify({
        reply: "",
        tools: [{ name: "email.search", args: { gmailLabel: "SPAM", deep: true } }],
      }),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.calls[0]?.args.deep).toBe(true);
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
