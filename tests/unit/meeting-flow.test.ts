import { describe, expect, test } from "bun:test";
import {
  askText,
  asMeetingPrep,
  meetingStage,
  mergePrep,
  readyText,
} from "../../convex/lib/calendar/meetingFlow";
import { renderOutcomes } from "../../convex/lib/tools/outcomes";
import { TOOL_META, TOOL_SCHEMAS } from "../../convex/lib/tools/catalog";
import { planningSystemPrompt } from "../../convex/lib/prompts/assistant";

const TZ = "Africa/Lagos";
const lagos = (hh: number, mm = 0) => Date.UTC(2026, 9, 17, hh - 1, mm);

describe("meetingStage", () => {
  const start = lagos(14, 0);
  test("asks up to three hours ahead", () => {
    expect(meetingStage(start, lagos(10, 59), TZ, 10)).toBeNull();
    expect(meetingStage(start, lagos(11, 0), TZ, 10)).toBe("ask");
    expect(meetingStage(start, lagos(13, 30), TZ, 10)).toBe("ask");
  });
  test("leaves the last 25 minutes to the ready nudge", () => {
    expect(meetingStage(start, lagos(13, 40), TZ, 10)).toBeNull();
    expect(meetingStage(start, lagos(13, 50), TZ, 10)).toBe("ready");
    expect(meetingStage(start, lagos(14, 0), TZ, 10)).toBeNull();
  });
  test("an early meeting is asked about from 07:00, not at dawn", () => {
    expect(meetingStage(lagos(9, 0), lagos(6, 30), TZ, 10)).toBeNull();
    expect(meetingStage(lagos(9, 0), lagos(7, 0), TZ, 10)).toBe("ask");
  });
});

describe("messages", () => {
  test("the ask is one question", () => {
    const t = askText("Standup", lagos(10, 0), TZ);
    expect(t).toBe("📅 You have Standup at 10:00 today. Are you joining?");
    expect(t.split("?").length - 1).toBe(1);
  });

  test("the ready nudge reads back their prep", () => {
    const prep = mergePrep(null, { eventId: "e1", title: "Standup", startMs: lagos(10) }, { note: "THE-89 shipped" });
    const t = readyText({ title: "Standup", startMs: lagos(10), link: "https://meet.google.com/x" }, lagos(9, 50), TZ, prep);
    expect(t).toContain("Standup in 10 min (10:00). Ready to join?");
    expect(t).toContain("Join: https://meet.google.com/x");
    expect(t).toContain("Remember, you're covering:\n- THE-89 shipped");
  });

  test("no prep, no prep section", () => {
    expect(readyText({ title: "Standup", startMs: lagos(10) }, lagos(9, 50), TZ, null)).not.toContain("covering");
  });
});

describe("mergePrep", () => {
  const ev = { eventId: "e1", title: "Standup", startMs: lagos(10) };
  test("adds notes once and keeps attendance", () => {
    let p = mergePrep(null, ev, { attending: true });
    p = mergePrep(p, ev, { note: "API delay" });
    p = mergePrep(p, ev, { note: "api delay" });
    expect(p.notes).toEqual(["API delay"]);
    expect(p.attending).toBe(true);
  });
  test("round-trips through storage and rejects junk", () => {
    const p = mergePrep(null, ev, { note: "x" });
    expect(asMeetingPrep(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(asMeetingPrep("nope")).toBeNull();
  });
});

describe("meeting.prep tool", () => {
  test("is not consequential and all args are optional", () => {
    expect(TOOL_META["meeting.prep"].consequential).toBe(false);
    expect(TOOL_SCHEMAS["meeting.prep"].safeParse({}).success).toBe(true);
  });

  test("confirms a prep note with the running list", () => {
    const out = renderOutcomes("", [
      {
        name: "meeting.prep",
        ok: true,
        result: { found: true, changed: true, title: "Standup", when: "Sat 17 Oct 2026, 10:00", attending: true, notes: ["A", "B"], added: "B" },
      },
    ]);
    expect(out).toBe("📅 Added to your prep for Standup (Sat 17 Oct 2026, 10:00).\nYour prep so far:\n- A\n- B");
  });

  test("the chat prompt knows the flow and offers to write blockers", () => {
    const prompt = planningSystemPrompt({
      displayName: "Adedotun",
      timezone: TZ,
      nowMs: lagos(9),
      projects: [],
      openTasks: [],
      reminders: [],
      connectedAccounts: [],
      customInstructions: [],
      activeSkills: [],
      userContext: [],
    });
    expect(prompt).toContain("11. MEETINGS.");
    expect(prompt).toContain("what is blocked, the impact, what they need");
  });
});
