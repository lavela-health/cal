import { describe, expect, it } from "vitest";
import { formatMinutesAsHours } from "./formatMinutesAsHours";

// Stands in for i18next's t: returns the key plus its interpolations so the test asserts which
// key was chosen and with what, rather than asserting an English string.
const t = (key: string, vars?: Record<string, unknown>): string =>
  `${key}(${Object.entries(vars ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join(",")})`;

describe("formatMinutesAsHours", () => {
  it("uses the whole-hours key when the minutes divide evenly", () => {
    expect(formatMinutesAsHours(480, t)).toBe("duration_hours(hours=8)");
  });

  // A 50-minute session against a 60-minute slot interval makes remainders the normal case,
  // so dropping them would quietly misreport most providers.
  it("keeps the remaining minutes when they do not", () => {
    expect(formatMinutesAsHours(410, t)).toBe("duration_hours_minutes(hours=6,minutes=50)");
  });

  it("formats under an hour as minutes alone", () => {
    expect(formatMinutesAsHours(50, t)).toBe("duration_minutes(minutes=50)");
  });

  it("formats nothing as zero hours rather than as blank", () => {
    expect(formatMinutesAsHours(0, t)).toBe("duration_hours(hours=0)");
  });
});
