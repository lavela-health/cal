import dayjs from "@calcom/dayjs";
import { describe, expect, it } from "vitest";
import { mondayOf } from "./mondayOf";

describe("mondayOf", () => {
  it("returns the same day for a Monday", () => {
    expect(mondayOf(dayjs.utc("2026-09-28T13:00:00Z")).format("YYYY-MM-DD")).toBe("2026-09-28");
  });

  it("walks back to Monday from midweek", () => {
    expect(mondayOf(dayjs.utc("2026-10-01T13:00:00Z")).format("YYYY-MM-DD")).toBe("2026-09-28");
  });

  // The off-by-one that a naive `day() - 1` gets wrong: dayjs numbers Sunday as 0, so Sunday
  // belongs to the week that started six days earlier, not to the one starting tomorrow.
  it("treats Sunday as the end of the week, not the start", () => {
    expect(mondayOf(dayjs.utc("2026-10-04T13:00:00Z")).format("YYYY-MM-DD")).toBe("2026-09-28");
  });

  it("returns the start of the day", () => {
    expect(mondayOf(dayjs.utc("2026-10-01T13:45:00Z")).format("HH:mm")).toBe("00:00");
  });
});
