import { describe, expect, test } from "bun:test";
import {
  localDate,
  addDays,
  startOfLocalDay,
  dayWindow,
  daysWindow,
  restOfDay,
  namedWindow,
} from "../../convex/lib/calendar/window";
import {
  isAllDay,
  whenToMs,
  displayEndMs,
  otherAttendees,
  affectsOthers,
  mergeIntervals,
  findFreeSlots,
} from "../../convex/lib/calendar/events";
import {
  buildListEventsQuery,
  buildCreateEventBody,
} from "../../convex/connectors/gcal/client";

const LAGOS = "Africa/Lagos"; // UTC+1, no DST
const NY = "America/New_York"; // has DST — the interesting one
const HOUR = 3_600_000;

describe("localDate — the day it is where you are", () => {
  test("23:30 UTC is already tomorrow in Lagos", () => {
    const ms = Date.parse("2026-09-08T23:30:00Z");
    expect(localDate(ms, "UTC")).toBe("2026-09-08");
    expect(localDate(ms, LAGOS)).toBe("2026-09-09");
  });

  test("00:30 UTC is still yesterday in New York", () => {
    const ms = Date.parse("2026-09-09T00:30:00Z");
    expect(localDate(ms, NY)).toBe("2026-09-08");
  });
});

describe("addDays — calendar arithmetic, not 24-hour arithmetic", () => {
  test("crosses a month boundary", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });
  test("crosses a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  test("goes backwards", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  test("handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("dayWindow — a whole local day", () => {
  const now = Date.parse("2026-09-08T14:00:00Z");

  test("today starts at local midnight, not UTC midnight", () => {
    const w = dayWindow(now, LAGOS);
    // Lagos is +01:00, so local midnight is 23:00 UTC the day before.
    expect(new Date(w.startMs).toISOString()).toBe("2026-09-07T23:00:00.000Z");
    expect(w.dates).toEqual(["2026-09-08"]);
  });

  test("the window is exactly one day long", () => {
    const w = dayWindow(now, LAGOS);
    expect(w.endMs - w.startMs).toBe(24 * HOUR);
  });

  test("tomorrow is the next local day, not now plus 24 hours", () => {
    const w = dayWindow(now, LAGOS, 1);
    expect(w.dates).toEqual(["2026-09-09"]);
    expect(w.startMs).toBe(startOfLocalDay("2026-09-09", LAGOS));
  });

  test("a spring-forward day is 23 hours, and the window still ends correctly", () => {
    // US DST begins 2026-03-08. That local day is 23 hours long.
    const springForward = Date.parse("2026-03-08T15:00:00Z");
    const w = dayWindow(springForward, NY);
    expect(w.dates).toEqual(["2026-03-08"]);
    expect(w.endMs - w.startMs).toBe(23 * HOUR);
    // And it ends exactly at the next local midnight, which is the point.
    expect(w.endMs).toBe(startOfLocalDay("2026-03-09", NY));
  });

  test("a fall-back day is 25 hours", () => {
    const fallBack = Date.parse("2026-11-01T15:00:00Z");
    const w = dayWindow(fallBack, NY);
    expect(w.endMs - w.startMs).toBe(25 * HOUR);
  });
});

describe("daysWindow and restOfDay", () => {
  const now = Date.parse("2026-09-08T14:00:00Z"); // 15:00 Lagos

  test("a week is seven consecutive dates starting today", () => {
    const w = daysWindow(now, LAGOS, 7);
    expect(w.dates).toHaveLength(7);
    expect(w.dates[0]).toBe("2026-09-08");
    expect(w.dates[6]).toBe("2026-09-14");
  });

  test("restOfDay starts now, not at midnight", () => {
    const w = restOfDay(now, LAGOS);
    expect(w.startMs).toBe(now);
    expect(w.endMs).toBe(startOfLocalDay("2026-09-09", LAGOS));
  });

  test("named windows resolve to distinct, ordered ranges", () => {
    const today = namedWindow("today", now, LAGOS);
    const tomorrow = namedWindow("tomorrow", now, LAGOS);
    const nextWeek = namedWindow("next_week", now, LAGOS);
    expect(tomorrow.startMs).toBe(today.endMs);
    expect(nextWeek.startMs).toBeGreaterThan(tomorrow.endMs);
    expect(nextWeek.dates).toHaveLength(7);
  });
});

describe("all-day events", () => {
  test("a bare date is all day; a dateTime is not", () => {
    expect(isAllDay({ date: "2026-09-08" })).toBe(true);
    expect(isAllDay({ dateTime: "2026-09-08T10:00:00+01:00" })).toBe(false);
  });

  test("an all-day date anchors to LOCAL midnight, not UTC midnight", () => {
    // Date.parse("2026-09-08") is UTC midnight — 01:00 Lagos, i.e. the right
    // day by luck here but the wrong day for anywhere west of Greenwich.
    const ms = whenToMs({ date: "2026-09-08" }, NY);
    expect(localDate(ms!, NY)).toBe("2026-09-08");
  });

  test("Google's exclusive end date is walked back for display", () => {
    // A one-day event on the 8th is stored as end = the 9th.
    const event = {
      id: "e1",
      start: { date: "2026-09-08" },
      end: { date: "2026-09-09" },
    };
    const shown = displayEndMs(event, LAGOS)!;
    expect(localDate(shown, LAGOS)).toBe("2026-09-08");
  });

  test("a timed event's end is left exactly alone", () => {
    const event = {
      id: "e2",
      start: { dateTime: "2026-09-08T10:00:00+01:00" },
      end: { dateTime: "2026-09-08T11:00:00+01:00" },
    };
    expect(displayEndMs(event, LAGOS)).toBe(Date.parse("2026-09-08T11:00:00+01:00"));
  });
});

describe("otherAttendees — the approval predicate", () => {
  const me = ["adedotungabriel20@gmail.com"];

  test("a solo event with no attendees affects nobody", () => {
    const e = { id: "e", start: {}, end: {} };
    expect(otherAttendees(e, me)).toEqual([]);
  });

  test("a solo event where YOU are the only attendee still affects nobody", () => {
    // This is the common shape, and treating it as a meeting would demand a
    // tap every time you block your own focus time.
    const e = {
      id: "e",
      start: {},
      end: {},
      attendees: [{ email: "adedotungabriel20@gmail.com", self: true }],
    };
    expect(otherAttendees(e, me)).toEqual([]);
  });

  test("your own address counts as you even when `self` is absent", () => {
    const e = {
      id: "e",
      start: {},
      end: {},
      attendees: [{ email: "ADEDOTUNGABRIEL20@gmail.com" }],
    };
    expect(otherAttendees(e, me)).toEqual([]);
  });

  test("a meeting room is not a person", () => {
    const e = {
      id: "e",
      start: {},
      end: {},
      attendees: [{ email: "c_1884@resource.calendar.google.com" }],
    };
    expect(otherAttendees(e, me)).toEqual([]);
  });

  test("a real guest is found", () => {
    const e = {
      id: "e",
      start: {},
      end: {},
      attendees: [
        { email: "adedotungabriel20@gmail.com", self: true },
        { email: "paul@client.example" },
      ],
    };
    expect(otherAttendees(e, me)).toEqual(["paul@client.example"]);
  });

  test("affectsOthers agrees with otherAttendees on every case above", () => {
    expect(affectsOthers([], me)).toBe(false);
    expect(affectsOthers(["adedotungabriel20@gmail.com"], me)).toBe(false);
    expect(affectsOthers(["c_1@resource.calendar.google.com"], me)).toBe(false);
    expect(affectsOthers(["paul@client.example"], me)).toBe(true);
    // Mixed: one guest is enough.
    expect(affectsOthers(["adedotungabriel20@gmail.com", "paul@x.example"], me)).toBe(true);
  });

  test("with several of your own addresses, all of them are you", () => {
    const many = ["a@x.com", "b@y.com"];
    expect(affectsOthers(["b@y.com"], many)).toBe(false);
    expect(affectsOthers(["c@z.com"], many)).toBe(true);
  });
});

describe("mergeIntervals", () => {
  test("overlapping blocks become one", () => {
    expect(
      mergeIntervals([
        { startMs: 0, endMs: 100 },
        { startMs: 50, endMs: 150 },
      ]),
    ).toEqual([{ startMs: 0, endMs: 150 }]);
  });

  test("touching blocks become one", () => {
    expect(
      mergeIntervals([
        { startMs: 0, endMs: 100 },
        { startMs: 100, endMs: 200 },
      ]),
    ).toEqual([{ startMs: 0, endMs: 200 }]);
  });

  test("a block fully inside another disappears into it", () => {
    expect(
      mergeIntervals([
        { startMs: 0, endMs: 500 },
        { startMs: 100, endMs: 200 },
      ]),
    ).toEqual([{ startMs: 0, endMs: 500 }]);
  });

  test("zero-length blocks are dropped, not kept as points", () => {
    expect(mergeIntervals([{ startMs: 10, endMs: 10 }])).toEqual([]);
  });

  test("unsorted input still merges correctly", () => {
    expect(
      mergeIntervals([
        { startMs: 300, endMs: 400 },
        { startMs: 0, endMs: 100 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 300, endMs: 400 },
    ]);
  });
});

describe("findFreeSlots", () => {
  const date = "2026-09-08";
  const midnight = startOfLocalDay(date, LAGOS);
  const at = (hour: number) => midnight + hour * HOUR;
  // Well before working hours, so "now" never clips the day.
  const early = at(6);

  test("an empty day is one slot spanning working hours", () => {
    const slots = findFreeSlots({
      dates: [date],
      timeZone: LAGOS,
      busy: [],
      durationMs: HOUR,
      nowMs: early,
    });
    expect(slots).toEqual([{ startMs: at(9), endMs: at(18) }]);
  });

  test("a midday meeting splits the day in two", () => {
    const slots = findFreeSlots({
      dates: [date],
      timeZone: LAGOS,
      busy: [{ startMs: at(12), endMs: at(13) }],
      durationMs: HOUR,
      nowMs: early,
    });
    expect(slots).toEqual([
      { startMs: at(9), endMs: at(12) },
      { startMs: at(13), endMs: at(18) },
    ]);
  });

  test("a gap shorter than the duration is not offered", () => {
    const slots = findFreeSlots({
      dates: [date],
      timeZone: LAGOS,
      busy: [
        { startMs: at(9), endMs: at(11) },
        { startMs: at(11.5), endMs: at(18) },
      ],
      durationMs: HOUR,
      nowMs: early,
    });
    expect(slots).toEqual([]);
  });

  test("a slot in the past is never proposed", () => {
    const slots = findFreeSlots({
      dates: [date],
      timeZone: LAGOS,
      busy: [],
      durationMs: HOUR,
      nowMs: at(15),
    });
    expect(slots).toEqual([{ startMs: at(15), endMs: at(18) }]);
  });

  test("a day already over yields nothing", () => {
    const slots = findFreeSlots({
      dates: [date],
      timeZone: LAGOS,
      busy: [],
      durationMs: HOUR,
      nowMs: at(23),
    });
    expect(slots).toEqual([]);
  });

  test("events outside working hours do not consume the day", () => {
    const slots = findFreeSlots({
      dates: [date],
      timeZone: LAGOS,
      busy: [{ startMs: at(6), endMs: at(8) }],
      durationMs: HOUR,
      nowMs: early,
    });
    expect(slots).toEqual([{ startMs: at(9), endMs: at(18) }]);
  });

  test("an all-day busy block leaves no room", () => {
    const slots = findFreeSlots({
      dates: [date],
      timeZone: LAGOS,
      busy: [{ startMs: midnight, endMs: midnight + 24 * HOUR }],
      durationMs: HOUR,
      nowMs: early,
    });
    expect(slots).toEqual([]);
  });

  test("searching several days returns slots on each", () => {
    const slots = findFreeSlots({
      dates: [date, addDays(date, 1)],
      timeZone: LAGOS,
      busy: [],
      durationMs: 2 * HOUR,
      nowMs: early,
    });
    expect(slots).toHaveLength(2);
  });

  test("the limit stops the search", () => {
    const slots = findFreeSlots({
      dates: [date, addDays(date, 1), addDays(date, 2)],
      timeZone: LAGOS,
      busy: [],
      durationMs: HOUR,
      nowMs: early,
      limit: 2,
    });
    expect(slots).toHaveLength(2);
  });

  test("working hours are configurable", () => {
    const slots = findFreeSlots({
      dates: [date],
      timeZone: LAGOS,
      busy: [],
      durationMs: HOUR,
      nowMs: early,
      workingHours: { startHour: 8, endHour: 10 },
    });
    expect(slots).toEqual([{ startMs: at(8), endMs: at(10) }]);
  });
});

describe("Calendar request builders", () => {
  test("listing always expands recurrences", () => {
    // Without singleEvents a weekly standup returns once, as a rule, and
    // every repeating meeting silently vanishes from "what's my day".
    const q = buildListEventsQuery({
      timeMinIso: "2026-09-08T00:00:00+01:00",
      timeMaxIso: "2026-09-09T00:00:00+01:00",
    });
    expect(q).toContain("singleEvents=true");
    expect(q).toContain("orderBy=startTime");
  });

  test("maxResults is capped even if a caller asks for more", () => {
    const q = buildListEventsQuery({ timeMinIso: "a", timeMaxIso: "b", limit: 5000 });
    expect(q).toContain("maxResults=100");
  });

  test("a solo event body carries no attendees key at all", () => {
    const body = buildCreateEventBody({
      summary: "Focus",
      startIso: "2026-09-08T10:00:00+01:00",
      endIso: "2026-09-08T12:00:00+01:00",
      timeZone: LAGOS,
    });
    expect(body.attendees).toBeUndefined();
    expect(body.summary).toBe("Focus");
  });

  test("attendees are passed through as objects", () => {
    const body = buildCreateEventBody({
      summary: "Call",
      startIso: "2026-09-08T14:00:00+01:00",
      endIso: "2026-09-08T15:00:00+01:00",
      timeZone: LAGOS,
      attendeeEmails: ["paul@x.example"],
    });
    expect(body.attendees).toEqual([{ email: "paul@x.example" }]);
  });
});
