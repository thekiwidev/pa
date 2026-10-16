import { describe, expect, test } from "bun:test";
import {
  CHECKIN_MIN_GAP_MS,
  DEFAULT_PERSONA,
  PERSONAS,
  PERSONA_HEADING,
  PERSONA_IDS,
  checkinInstructions,
  checkinsEnabled,
  decideCheckin,
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

  test("every personality checks in at least twice, inside waking hours, in order", () => {
    for (const id of PERSONA_IDS) {
      const times = PERSONAS[id].checkins.map((c) => c.time);
      expect(times.length).toBeGreaterThanOrEqual(2);
      expect([...times].sort()).toEqual(times);
      for (const t of times) {
        expect(t >= "07:00" && t <= "21:30").toBe(true);
      }
    }
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
  test("PM: 12:30 is due from 12:30 for 90 minutes", () => {
    expect(dueCheckin(PM, lagos(12, 29), TZ)).toBeNull();
    expect(dueCheckin(PM, lagos(12, 30), TZ)?.slot.id).toBe("midday");
    expect(dueCheckin(PM, lagos(13, 59), TZ)?.slot.id).toBe("midday");
    expect(dueCheckin(PM, lagos(14, 0), TZ)).toBeNull();
  });

  test("the dedupe key is per day, per personality, per slot", () => {
    expect(dueCheckin(PM, lagos(17, 30), TZ)?.key).toBe("2026-10-16:project_manager:eod");
  });

  test("nothing overnight", () => {
    for (const id of PERSONA_IDS) {
      expect(dueCheckin(PERSONAS[id], lagos(3, 0), TZ)).toBeNull();
    }
  });
});

describe("decideCheckin", () => {
  const at = lagos(12, 30);

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

  test("never two check-ins within two hours, even after a persona switch", () => {
    // Mom's 13:00 right after the PM's 12:30.
    const d = decideCheckin({
      persona: MOM,
      enabled: true,
      nowMs: lagos(13, 0),
      timezone: TZ,
      lastCheckinMs: lagos(12, 30),
    });
    expect(d).toEqual({ send: false, reason: "too_soon" });
    const later = decideCheckin({
      persona: MOM,
      enabled: true,
      nowMs: lagos(12, 30) + CHECKIN_MIN_GAP_MS,
      timezone: TZ,
      lastCheckinMs: lagos(12, 30),
    });
    expect(later.send).toBe(false); // 14:30 is past Mom's 13:00 window
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
    const text = checkinInstructions(PM, PM.checkins[0]!, "Fri 16 Oct 2026, 12:30");
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
