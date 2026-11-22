import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFS,
  decideSend,
  effectiveMode,
  inQuietHours,
  notifyFrom,
  quietHoursEndMs,
  type NotifyKind,
} from "../../convex/lib/notify/policy";

const TZ = "Africa/Lagos";
/** 2026-10-19 at hh:mm Lagos time (UTC+1). */
const lagos = (hh: number, mm = 0, day = 19) => Date.UTC(2026, 9, day, hh - 1, mm);
const NOON = lagos(12);
const active = NOON - 60_000;

const ALL: NotifyKind[] = [
  "email_important", "email_unread_followup", "reminder", "digest", "news", "checkin",
  "scripture", "saved_nudge", "weekend_pick", "meeting_nudge", "ops_critical", "ops_digest",
];
const send = (kind: NotifyKind, prefs = DEFAULT_PREFS, now = NOON, lastInboundAt: number | undefined = active) =>
  decideSend({ kind, prefs, now, lastInboundAt, tz: TZ });

describe("notifyFrom", () => {
  test("empty input gives the defaults", () => {
    expect(notifyFrom(null)).toEqual(DEFAULT_PREFS);
    expect(notifyFrom("junk")).toEqual(DEFAULT_PREFS);
  });
  test("bad fields fall back one by one", () => {
    const p = notifyFrom({ mode: "loud", inactivityHours: -3, quietHours: { from: "25:00", until: "06:00" }, kinds: { checkin: true, nope: true, news: "yes" } });
    expect(p.mode).toBe("normal");
    expect(p.inactivityHours).toBe(DEFAULT_PREFS.inactivityHours);
    expect(p.quietHours).toEqual({ from: DEFAULT_PREFS.quietHours.from, until: "06:00" });
    expect(p.kinds).toEqual({ checkin: true });
  });
  test("valid values are kept", () => {
    const p = notifyFrom({ mode: "silent", until: 5, inactivityHours: 0, emailGraceMinutes: 30 });
    expect(p).toMatchObject({ mode: "silent", until: 5, inactivityHours: 0, emailGraceMinutes: 30 });
  });
});

describe("effectiveMode", () => {
  test("active owner keeps the configured mode", () => {
    expect(effectiveMode(DEFAULT_PREFS, NOON, active)).toBe("normal");
  });
  test("silent with an expired until reverts to normal", () => {
    const p = { ...DEFAULT_PREFS, mode: "silent" as const, until: NOON - 1 };
    expect(effectiveMode(p, NOON, active)).toBe("normal");
    expect(effectiveMode({ ...p, until: NOON + 1 }, NOON, active)).toBe("silent");
  });
  test("inactivity past the threshold drops normal to quiet", () => {
    expect(effectiveMode(DEFAULT_PREFS, NOON, NOON - 25 * 3_600_000)).toBe("quiet");
    expect(effectiveMode(DEFAULT_PREFS, NOON, NOON - 23 * 3_600_000)).toBe("normal");
  });
  test("never heard from the owner counts as inactive", () => {
    expect(effectiveMode(DEFAULT_PREFS, NOON, undefined)).toBe("quiet");
  });
  test("inactivityHours 0 turns auto-quiet off", () => {
    expect(effectiveMode({ ...DEFAULT_PREFS, inactivityHours: 0 }, NOON, undefined)).toBe("normal");
  });
  test("inactivity never lifts silent", () => {
    expect(effectiveMode({ ...DEFAULT_PREFS, mode: "silent" }, NOON, active)).toBe("silent");
  });
});

describe("quiet hours", () => {
  test("22:00-07:00 wraps midnight", () => {
    expect(inQuietHours(DEFAULT_PREFS, lagos(23), TZ)).toBe(true);
    expect(inQuietHours(DEFAULT_PREFS, lagos(3), TZ)).toBe(true);
    expect(inQuietHours(DEFAULT_PREFS, lagos(7), TZ)).toBe(false);
    expect(inQuietHours(DEFAULT_PREFS, lagos(21, 59), TZ)).toBe(false);
  });
  test("equal from and until means no quiet hours", () => {
    const p = { ...DEFAULT_PREFS, quietHours: { from: "08:00", until: "08:00" } };
    expect(inQuietHours(p, lagos(3), TZ)).toBe(false);
  });
  test("end is the coming 07:00, before or after midnight", () => {
    expect(quietHoursEndMs(DEFAULT_PREFS, lagos(23), TZ)).toBe(lagos(7, 0, 20));
    expect(quietHoursEndMs(DEFAULT_PREFS, lagos(3), TZ)).toBe(lagos(7));
  });
});

describe("decideSend: normal mode, active owner", () => {
  test("everything switched on by default is sent", () => {
    for (const kind of ["email_important", "email_unread_followup", "reminder", "digest", "news", "meeting_nudge", "ops_critical", "ops_digest"] as const) {
      expect(send(kind)).toBe("send");
    }
  });
  test("optional chatter is opt-in", () => {
    for (const kind of ["checkin", "scripture", "saved_nudge", "weekend_pick"] as const) {
      expect(send(kind)).toBe("drop");
    }
  });
  test("opting in sends it", () => {
    const p = { ...DEFAULT_PREFS, kinds: { checkin: true, scripture: true } };
    expect(send("checkin", p)).toBe("send");
    expect(send("scripture", p)).toBe("send");
  });
  test("a kind can be switched off", () => {
    expect(send("email_important", { ...DEFAULT_PREFS, kinds: { email_important: false } })).toBe("drop");
    expect(send("meeting_nudge", { ...DEFAULT_PREFS, kinds: { meeting_nudge: false } })).toBe("drop");
  });
  test("reminders and critical ops cannot be switched off", () => {
    const p = { ...DEFAULT_PREFS, kinds: { reminder: false, ops_critical: false } };
    expect(send("reminder", p)).toBe("send");
    expect(send("ops_critical", p)).toBe("send");
  });
});

describe("decideSend: quiet mode", () => {
  const quiet = { ...DEFAULT_PREFS, mode: "quiet" as const, kinds: { checkin: true, scripture: true } };
  test("only important mail, reminders, asked digests and critical ops", () => {
    for (const kind of ["email_important", "email_unread_followup", "reminder", "digest", "news", "ops_critical"] as const) {
      expect(send(kind, quiet)).toBe("send");
    }
    for (const kind of ["checkin", "scripture", "saved_nudge", "weekend_pick", "meeting_nudge", "ops_digest"] as const) {
      expect(send(kind, quiet)).toBe("drop");
    }
  });
});

describe("decideSend: silent mode", () => {
  const silent = { ...DEFAULT_PREFS, mode: "silent" as const };
  test("only important mail, reminders and critical ops", () => {
    for (const kind of ["email_important", "email_unread_followup", "reminder", "ops_critical"] as const) {
      expect(send(kind, silent)).toBe("send");
    }
    for (const kind of ["digest", "news", "checkin", "scripture", "saved_nudge", "weekend_pick", "meeting_nudge", "ops_digest"] as const) {
      expect(send(kind, silent)).toBe("drop");
    }
  });
});

describe("decideSend: inactivity auto-quiet", () => {
  const stale = NOON - 3 * 86_400_000;
  test("a silent owner gets only mail, reminders, asked digests and critical ops", () => {
    const p = { ...DEFAULT_PREFS, kinds: { checkin: true, scripture: true } };
    const sent = ALL.filter((k) => send(k, p, NOON, stale) === "send");
    expect([...sent].sort()).toEqual(["digest", "email_important", "email_unread_followup", "news", "ops_critical", "reminder"]);
  });
});

describe("decideSend: quiet hours", () => {
  const night = lagos(23);
  const late = night - 60_000;
  test("optional kinds are dropped at night", () => {
    const p = { ...DEFAULT_PREFS, kinds: { checkin: true } };
    expect(send("checkin", p, night, late)).toBe("drop");
    expect(send("meeting_nudge", DEFAULT_PREFS, night, late)).toBe("drop");
  });
  test("important mail is deferred, urgent mail is not", () => {
    expect(send("email_important", DEFAULT_PREFS, night, late)).toBe("defer");
    expect(send("email_unread_followup", DEFAULT_PREFS, night, late)).toBe("defer");
    expect(decideSend({ kind: "email_important", prefs: DEFAULT_PREFS, now: night, lastInboundAt: late, tz: TZ, urgent: true })).toBe("send");
  });
  test("reminders, critical ops and asked digests ignore quiet hours", () => {
    expect(send("reminder", DEFAULT_PREFS, night, late)).toBe("send");
    expect(send("ops_critical", DEFAULT_PREFS, night, late)).toBe("send");
    expect(send("digest", DEFAULT_PREFS, night, late)).toBe("send");
  });
});

import { applyNotifyPatch, describeNotify, parseHours } from "../../convex/lib/notify/policy";

describe("applyNotifyPatch", () => {
  test("silent for hours sets until; resume clears it", () => {
    const silent = applyNotifyPatch(DEFAULT_PREFS, { mode: "silent", hours: 48 }, NOON);
    expect(silent).toMatchObject({ mode: "silent", until: NOON + 48 * 3_600_000 });
    const back = applyNotifyPatch(silent, { mode: "normal" }, NOON);
    expect(back.mode).toBe("normal");
    expect(back.until).toBeUndefined();
  });
  test("explicit end wins over hours", () => {
    expect(applyNotifyPatch(DEFAULT_PREFS, { mode: "quiet", hours: 1, untilMs: 99 }, NOON).until).toBe(99);
  });
  test("kinds merge and the input is not mutated", () => {
    const base = { ...DEFAULT_PREFS, kinds: { news: false } };
    const next = applyNotifyPatch(base, { kinds: { checkin: true } }, NOON);
    expect(next.kinds).toEqual({ news: false, checkin: true });
    expect(base.kinds).toEqual({ news: false });
  });
  test("invalid values are normalised away", () => {
    expect(applyNotifyPatch(DEFAULT_PREFS, { quietFrom: "25:99" }, NOON).quietHours.from).toBe("22:00");
  });
});

describe("parseHours", () => {
  test("durations", () => {
    expect(parseHours("2d")).toBe(48);
    expect(parseHours("36h")).toBe(36);
    expect(parseHours("90m")).toBe(1.5);
    expect(parseHours("3")).toBe(3);
    expect(parseHours("soon")).toBeNull();
    expect(parseHours("0")).toBeNull();
    expect(parseHours(undefined)).toBeNull();
  });
});

describe("describeNotify", () => {
  const fmt = (ms: number) => String(ms);
  test("says why the effective mode differs", () => {
    const text = describeNotify(DEFAULT_PREFS, NOON, NOON - 3 * 86_400_000, fmt);
    expect(text).toContain("acting as quiet");
    expect(text).toContain("Off: check-ins, verses");
  });
  test("active owner sees no override line", () => {
    expect(describeNotify(DEFAULT_PREFS, NOON, active, fmt)).not.toContain("acting as");
  });
});

import { TOOL_META, TOOL_SCHEMAS } from "../../convex/lib/tools/catalog";

describe("notify.settings tool", () => {
  test("schema and meta exist, read-only of the outside world", () => {
    expect(TOOL_META["notify.settings"].consequential).toBe(false);
    expect(TOOL_SCHEMAS["notify.settings"].safeParse({}).success).toBe(true);
    expect(TOOL_SCHEMAS["notify.settings"].safeParse({ mode: "silent", hours: 48, kinds: { scripture: false } }).success).toBe(true);
    expect(TOOL_SCHEMAS["notify.settings"].safeParse({ mode: "loud" }).success).toBe(false);
    expect(TOOL_SCHEMAS["notify.settings"].safeParse({ quietFrom: "10pm" }).success).toBe(false);
    expect(TOOL_SCHEMAS["notify.settings"].safeParse({ kinds: { reminder: false } }).success).toBe(true); // unknown key stripped, never stored (notifyFrom ignores it)
  });
});
