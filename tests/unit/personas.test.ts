import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PERSONA,
  PERSONAS,
  PERSONA_HEADING,
  PERSONA_IDS,
  checkinInstructions,
  checkinsEnabled,
  decideCheckin,
  decideWatch,
  idleThresholdMinutes,
  describePersonas,
  dueCheckin,
  personaOrDefault,
  resolvePersona,
} from "../../convex/lib/personas";
import { planningSystemPrompt } from "../../convex/lib/prompts/assistant";
import { renderOutcomes } from "../../convex/lib/tools/outcomes";
import { TOOL_META, TOOL_SCHEMAS } from "../../convex/lib/tools/catalog";

const TZ = "Africa/Lagos";
/** 2026-10-16 at hh:mm Lagos time (UTC+1). */
const lagos = (hh: number, mm = 0) => Date.UTC(2026, 9, 16, hh - 1, mm);
const PM = PERSONAS.project_manager;
const MOM = PERSONAS.mom;

describe("the four personalities", () => {
  test("Project Manager is the default", () => {
    expect(DEFAULT_PERSONA).toBe("project_manager");
    expect(personaOrDefault(null).id).toBe("project_manager");
    expect(personaOrDefault("nonsense").id).toBe("project_manager");
    expect(personaOrDefault("mom").id).toBe("mom");
  });

  test("exactly the four asked for exist", () => {
    expect([...PERSONA_IDS].sort()).toEqual(["corporate_pa", "friend", "mom", "project_manager"]);
  });

  test("every personality's slots are inside waking hours, in order, and respect its own gap", () => {
    for (const id of PERSONA_IDS) {
      const p = PERSONAS[id];
      const times = p.checkins.map((c) => c.time);
      expect([...times].sort()).toEqual(times);
      for (const t of times) expect(t >= "07:00" && t <= "22:00").toBe(true);
      const mins = times.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
      for (let i = 1; i < mins.length; i++) {
        expect(mins[i]! - mins[i - 1]!).toBeGreaterThanOrEqual(p.minGapMinutes);
      }
    }
  });

  test("the schedules Adedotun asked for", () => {
    expect(PERSONAS.mom.checkins.map((c) => c.id)).toEqual(["wake", "start", "midday", "wrap", "bed"]);
    expect(PERSONAS.project_manager.checkins.map((c) => c.id)).toEqual(["standup", "afternoon", "eod"]);
    expect(PERSONAS.corporate_pa.checkins.length).toBe(4);
    expect(PERSONAS.corporate_pa.watch).toBeDefined();
    expect(PERSONAS.project_manager.watch).toBeUndefined();
  });
});

describe("resolvePersona — what the user actually says", () => {
  test.each([
    ["mom", "mom"],
    ["Mum", "mom"],
    ["my mom", "mom"],
    ["switch to mama", "mom"],
    ["PM", "project_manager"],
    ["the project manager", "project_manager"],
    ["boss", "project_manager"],
    ["corporate PA", "corporate_pa"],
    ["personal assistant", "corporate_pa"],
    ["corporate_pa", "corporate_pa"],
    ["friend", "friend"],
    ["be my buddy", "friend"],
  ])("%p → %p", (said, id) => {
    expect(resolvePersona(said)).toBe(id as never);
  });

  test("unknown → null, never a guess", () => {
    expect(resolvePersona("pirate")).toBeNull();
    expect(resolvePersona("")).toBeNull();
  });
});

describe("dueCheckin", () => {
  test("PM: the 09:00 stand-up is due from 09:00 for 90 minutes", () => {
    expect(dueCheckin(PM, lagos(8, 59), TZ)).toBeNull();
    expect(dueCheckin(PM, lagos(9, 0), TZ)?.slot.id).toBe("standup");
    expect(dueCheckin(PM, lagos(10, 29), TZ)?.slot.id).toBe("standup");
    expect(dueCheckin(PM, lagos(10, 30), TZ)).toBeNull();
  });

  test("Mom: a late wake-up check gives way to the start-of-day one", () => {
    expect(dueCheckin(MOM, lagos(8, 30), TZ)?.slot.id).toBe("wake");
    expect(dueCheckin(MOM, lagos(9, 0), TZ)?.slot.id).toBe("start");
  });

  test("the dedupe key is per day, per personality, per slot", () => {
    expect(dueCheckin(PM, lagos(18, 0), TZ)?.key).toBe("2026-10-16:project_manager:eod");
  });

  test("nothing overnight", () => {
    for (const id of PERSONA_IDS) {
      expect(dueCheckin(PERSONAS[id], lagos(3, 0), TZ)).toBeNull();
    }
  });
});

describe("decideCheckin", () => {
  const at = lagos(13, 30);

  test("sends when a slot is due and nothing gets in the way", () => {
    const d = decideCheckin({ persona: PM, enabled: true, nowMs: at, timezone: TZ });
    expect(d.send).toBe(true);
  });

  test("off means off", () => {
    expect(decideCheckin({ persona: PM, enabled: false, nowMs: at, timezone: TZ })).toEqual({
      send: false,
      reason: "off",
    });
  });

  test("waits while the user is mid-conversation (retried next tick)", () => {
    const d = decideCheckin({
      persona: PM,
      enabled: true,
      nowMs: at,
      timezone: TZ,
      lastInboundMs: at - 5 * 60_000,
    });
    expect(d).toEqual({ send: false, reason: "user_active" });
  });

  test("the gap is the persona's own, and holds across a switch", () => {
    // PM's 13:30 right after a check-in at 12:00 → too soon (gap 120).
    expect(
      decideCheckin({ persona: PM, enabled: true, nowMs: lagos(13, 30), timezone: TZ, lastCheckinMs: lagos(12, 0) }),
    ).toEqual({ send: false, reason: "too_soon" });
    // Mom's 09:00 after her 07:30 → fine (gap 75).
    expect(
      decideCheckin({ persona: MOM, enabled: true, nowMs: lagos(9, 0), timezone: TZ, lastCheckinMs: lagos(7, 30) }).send,
    ).toBe(true);
  });

  test("check-ins are on unless explicitly turned off", () => {
    expect(checkinsEnabled(null)).toBe(true);
    expect(checkinsEnabled(true)).toBe(true);
    expect(checkinsEnabled(false)).toBe(false);
  });
});

describe("prompts carry the personality and keep the hard rules", () => {
  const base = {
    displayName: "Adedotun",
    timezone: TZ,
    nowMs: lagos(10),
    projects: [],
    openTasks: [],
    reminders: [],
    connectedAccounts: [],
    customInstructions: [],
    activeSkills: [],
    userContext: [],
  };

  test("the chat prompt speaks as Project Manager when nothing is set", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain(`${PERSONA_HEADING}: Project Manager`);
  });

  test("a switched persona replaces the voice, and the approval rule survives", () => {
    const prompt = planningSystemPrompt({ ...base, persona: MOM });
    expect(prompt).toContain(`${PERSONA_HEADING}: Mom`);
    expect(prompt).not.toContain(`${PERSONA_HEADING}: Project Manager`);
    expect(prompt).toContain("email.send_reply NEVER sends anything by itself");
    expect(prompt).toContain("This changes your tone only");
  });

  test("a check-in asks for an update and only looks ahead", () => {
    const text = checkinInstructions(PM, PM.checkins[0]!, "Fri 16 Oct 2026, 09:00");
    expect(text).toContain("asking them for an update");
    expect(text).toContain("never mention a meeting that has already ended");
    expect(text).toContain(PM.checkins[0]!.purpose);
  });

  test("/persona listing marks the current one and the default", () => {
    const listing = describePersonas("mom", true);
    expect(listing).toContain("Current: 👩🏾 Mom");
    expect(listing).toContain("Project Manager** (default)");
  });
});

describe("persona.set tool", () => {
  test("is not consequential and takes optional args", () => {
    expect(TOOL_META["persona.set"].consequential).toBe(false);
    expect(TOOL_SCHEMAS["persona.set"].safeParse({}).success).toBe(true);
    expect(TOOL_SCHEMAS["persona.set"].safeParse({ persona: "mom", checkins: false }).success).toBe(true);
  });

  test("a switch confirms in one line with the check-in times", () => {
    const out = renderOutcomes("", [
      {
        name: "persona.set",
        ok: true,
        result: {
          found: true,
          changed: true,
          name: "Mom",
          emoji: "👩🏾",
          checkinsOn: true,
          times: ["13:00", "18:00", "21:30"],
        },
      },
    ]);
    expect(out).toBe("👩🏾 Mom mode on. I'll check in at 13:00, 18:00 and 21:30.");
  });

  test("an unknown personality lists the real ones", () => {
    const out = renderOutcomes("", [
      {
        name: "persona.set",
        ok: true,
        result: { found: false, asked: "pirate", available: ["Project Manager", "Mom"] },
      },
    ]);
    expect(out).toContain('I don\'t have a "pirate" personality');
    expect(out).toContain("Project Manager, Mom");
  });
});

describe("decideWatch — the Corporate PA between slots", () => {
  const PA = PERSONAS.corporate_pa;
  const endOfToday = lagos(23, 59);
  const base = {
    persona: PA,
    enabled: true,
    timezone: TZ,
    events: [],
    tasks: [],
    endOfTodayMs: endOfToday,
  };
  const inProgress = { title: "THE-89 Item notes", status: "IN_PROGRESS" };

  test("only the PA watches", () => {
    expect(decideWatch({ ...base, persona: PM, nowMs: lagos(11) })).toEqual({ send: false, reason: "no_watch" });
  });

  test("only between 08:00 and 19:00", () => {
    expect(decideWatch({ ...base, nowMs: lagos(7, 30), tasks: [inProgress] }).send).toBe(false);
    expect(decideWatch({ ...base, nowMs: lagos(19, 30), tasks: [inProgress] })).toEqual({
      send: false,
      reason: "outside_hours",
    });
  });

  test("an event about an hour away gets a prep check-in, once per event", () => {
    const d = decideWatch({
      ...base,
      nowMs: lagos(14, 0),
      lastCheckinMs: lagos(12, 0),
      lastInboundMs: lagos(13, 0),
      events: [{ id: "ev1", title: "Client call", startMs: lagos(15, 0) }],
    });
    expect(d.send).toBe(true);
    if (d.send) {
      expect(d.key).toBe(`watch:event:ev1:${lagos(15, 0)}`);
      expect(d.slot.purpose).toContain("Client call");
    }
  });

  test("an event three hours away does not", () => {
    const d = decideWatch({
      ...base,
      nowMs: lagos(12, 0),
      lastCheckinMs: lagos(10, 0),
      lastInboundMs: lagos(11, 30),
      events: [{ id: "ev1", title: "Client call", startMs: lagos(15, 0) }],
    });
    expect(d.send).toBe(false);
  });

  test("quiet for long enough with work in progress → asks about that task", () => {
    const d = decideWatch({
      ...base,
      nowMs: lagos(14, 30),
      lastInboundMs: lagos(10, 0),
      lastCheckinMs: lagos(10, 0),
      tasks: [inProgress],
    });
    expect(d.send).toBe(true);
    if (d.send) expect(d.slot.purpose).toContain("THE-89 Item notes");
  });

  test("not when the user spoke recently", () => {
    expect(
      decideWatch({ ...base, nowMs: lagos(14, 30), lastInboundMs: lagos(14, 20), tasks: [inProgress] }),
    ).toEqual({ send: false, reason: "user_active" });
  });

  test("not with nothing open", () => {
    expect(
      decideWatch({ ...base, nowMs: lagos(16, 0), lastInboundMs: lagos(9, 0), lastCheckinMs: lagos(9, 0) }),
    ).toEqual({ send: false, reason: "nothing" });
  });

  test("more pending work means a shorter quiet period, never below the floor", () => {
    const w = PA.watch!;
    expect(idleThresholdMinutes(w, 0, 0)).toBe(180);
    expect(idleThresholdMinutes(w, 2, 0)).toBe(140);
    expect(idleThresholdMinutes(w, 10, 0)).toBe(90);
    expect(idleThresholdMinutes(w, 0, 1)).toBe(225);
  });
});
