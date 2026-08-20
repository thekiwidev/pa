import { describe, expect, test } from "bun:test";
import { offsetMinutes, toEpochMs, formatInstant } from "../../convex/lib/time";

const LAGOS = "Africa/Lagos";

describe("offsetMinutes", () => {
  test("Lagos is UTC+1 year round — no DST", () => {
    expect(offsetMinutes(LAGOS, Date.UTC(2026, 0, 15))).toBe(60);
    expect(offsetMinutes(LAGOS, Date.UTC(2026, 6, 15))).toBe(60);
  });

  test("UTC is zero", () => {
    expect(offsetMinutes("UTC", Date.UTC(2026, 6, 15))).toBe(0);
  });

  test("a DST zone changes across the year", () => {
    expect(offsetMinutes("Europe/London", Date.UTC(2026, 0, 15))).toBe(0);
    expect(offsetMinutes("Europe/London", Date.UTC(2026, 6, 15))).toBe(60);
  });
});

describe("toEpochMs", () => {
  test("a naive datetime is read as wall-clock in the user's zone", () => {
    // 10:00 in Lagos is 09:00 UTC.
    expect(toEpochMs("2026-08-21T10:00", LAGOS)).toBe(Date.UTC(2026, 7, 21, 9, 0));
  });

  test("seconds are optional", () => {
    expect(toEpochMs("2026-08-21T10:00:30", LAGOS)).toBe(
      Date.UTC(2026, 7, 21, 9, 0, 30),
    );
  });

  test("an explicit offset wins over the zone argument", () => {
    expect(toEpochMs("2026-08-21T10:00:00Z", LAGOS)).toBe(Date.UTC(2026, 7, 21, 10, 0));
    expect(toEpochMs("2026-08-21T10:00:00+02:00", LAGOS)).toBe(
      Date.UTC(2026, 7, 21, 8, 0),
    );
  });

  test("a DST-zone wall clock resolves to the right instant on both sides", () => {
    expect(toEpochMs("2026-01-15T10:00", "Europe/London")).toBe(
      Date.UTC(2026, 0, 15, 10, 0),
    );
    expect(toEpochMs("2026-07-15T10:00", "Europe/London")).toBe(
      Date.UTC(2026, 6, 15, 9, 0),
    );
  });

  test("throws rather than returning NaN", () => {
    expect(() => toEpochMs("next tuesday-ish", LAGOS)).toThrow("Unparseable datetime");
  });
});

describe("formatInstant", () => {
  test("renders in the user's zone", () => {
    const out = formatInstant(Date.UTC(2026, 7, 21, 9, 0), LAGOS);
    expect(out).toContain("21");
    expect(out).toContain("10:00");
  });
});
