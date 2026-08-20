import { describe, expect, test } from "bun:test";
import { requireEnv, checkConfig, REQUIRED_NOW } from "../../convex/lib/config";

// This file exists to prove the convex/lib/ purity rule works:
// it imports domain logic and runs with NO Convex runtime.

describe("requireEnv", () => {
  test("returns the value when set", () => {
    process.env.__TEST_VAR__ = "hello";
    expect(requireEnv("__TEST_VAR__")).toBe("hello");
    delete process.env.__TEST_VAR__;
  });

  test("throws an error naming the missing variable", () => {
    expect(() => requireEnv("__DEFINITELY_NOT_SET__")).toThrow(
      "__DEFINITELY_NOT_SET__ is not set on this deployment",
    );
  });
});

describe("checkConfig", () => {
  test("reports not-ok when a required variable is missing", () => {
    const saved = REQUIRED_NOW.map((n) => [n, process.env[n]] as const);
    for (const n of REQUIRED_NOW) delete process.env[n];

    const result = checkConfig();
    expect(result.ok).toBe(false);
    expect(result.missingCount).toBe(REQUIRED_NOW.length);

    for (const [n, v] of saved) if (v !== undefined) process.env[n] = v;
  });

  test("reports ok when every required variable is present", () => {
    const saved = REQUIRED_NOW.map((n) => [n, process.env[n]] as const);
    for (const n of REQUIRED_NOW) process.env[n] = "placeholder";

    expect(checkConfig().ok).toBe(true);

    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });
});
