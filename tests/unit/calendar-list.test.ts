import { describe, expect, test } from "bun:test";
import { calendarsToRead, MAX_CALENDARS_PER_ACCOUNT } from "../../convex/lib/calendar/calendars";

const cal = (id: string, extra: Record<string, unknown> = {}) => ({ id, summary: id, selected: true, ...extra });

describe("calendarsToRead", () => {
  test("reads every calendar shown in Google Calendar, primary first", () => {
    const ids = calendarsToRead([
      cal("work@group.calendar.google.com"),
      cal("me@gmail.com", { primary: true }),
      cal("team@group.calendar.google.com"),
    ]);
    expect(ids).toEqual(["me@gmail.com", "work@group.calendar.google.com", "team@group.calendar.google.com"]);
  });

  test("skips calendars hidden or unticked in Google Calendar", () => {
    expect(calendarsToRead([cal("a", { primary: true }), cal("b", { hidden: true }), cal("c", { selected: false })])).toEqual(["a"]);
  });

  test("skips the contacts-birthdays and week-number calendars", () => {
    expect(
      calendarsToRead([
        cal("me@gmail.com", { primary: true }),
        cal("addressbook#contacts@group.v.calendar.google.com"),
        cal("e_2_en#weeknum@group.v.calendar.google.com"),
        cal("en.ng#holiday@group.v.calendar.google.com"),
      ]),
    ).toEqual(["me@gmail.com", "en.ng#holiday@group.v.calendar.google.com"]);
  });

  test("always includes primary, even when it is unticked", () => {
    expect(calendarsToRead([cal("me@gmail.com", { primary: true, selected: false })])).toEqual(["me@gmail.com"]);
  });

  test("an empty list falls back to primary", () => {
    expect(calendarsToRead([])).toEqual(["primary"]);
  });

  test("is capped per account", () => {
    const many = Array.from({ length: 30 }, (_, i) => cal(`c${i}`));
    expect(calendarsToRead(many)).toHaveLength(MAX_CALENDARS_PER_ACCOUNT);
  });
});

import { renderOutcomes } from "../../convex/lib/tools/outcomes";

describe("an empty calendar answer", () => {
  test("names the calendars it checked, so empty never reads as broken", () => {
    const text = renderOutcomes(
      "",
      [{ name: "calendar.list_events", ok: true, result: { window: "today", calendarsChecked: ["a@x.com", "b@y.com"], events: [] } }] as never,
      [],
      "Africa/Lagos",
    );
    expect(text).toContain("Nothing on your calendar");
    expect(text).toContain("a@x.com, b@y.com");
  });
});
