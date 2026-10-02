import type { Dayjs } from "@calcom/dayjs";
import dayjs from "@calcom/dayjs";
import { describe, expect, it } from "vitest";
import type { WeeklyAvailabilitySlice, WeeklyAvailabilityUser } from "./WeeklyAvailabilityService";
import { WeeklyAvailabilityService } from "./WeeklyAvailabilityService";

const WEEK_START = "2026-09-28";

const user = (overrides?: Partial<WeeklyAvailabilityUser>): WeeklyAvailabilityUser => ({
  id: 1,
  timeZone: "UTC",
  hasCalendarCredentials: true,
  ...overrides,
});

const workday = (day: string, tz = "UTC"): { start: Dayjs; end: Dayjs } => ({
  start: dayjs.tz(`${day}T09:00`, tz),
  end: dayjs.tz(`${day}T17:00`, tz),
});

const emptySlice: WeeklyAvailabilitySlice = {
  scheduledDateRanges: [],
  busy: [],
  calendarFetchFailed: false,
};

describe("WeeklyAvailabilityService", () => {
  it("reports the week split into blocked, booked and free", async () => {
    const service = new WeeklyAvailabilityService(async () => ({
      scheduledDateRanges: [workday("2026-09-28"), workday("2026-09-29")],
      busy: [
        {
          start: "2026-09-28T11:00:00.000Z",
          end: "2026-09-28T12:00:00.000Z",
          source: "busy_time.calendar",
        },
        {
          start: "2026-09-29T09:00:00.000Z",
          end: "2026-09-29T10:00:00.000Z",
          source: "eventType-7-booking-42",
        },
      ],
      calendarFetchFailed: false,
    }));

    const result = await service.forWeek({ users: [user()], weekStart: WEEK_START });

    expect(result["1"]).toEqual({
      source: "live",
      scheduledMinutes: 960,
      blockedMinutes: 60,
      bookedMinutes: 60,
      capacityMinutes: 900,
      freeMinutes: 840,
      calendarConnected: true,
      calendarFetchFailed: false,
    });
  });

  it("asks for the week in the provider's own timezone", async () => {
    const asked: { dateFrom: string; dateTo: string }[] = [];
    const service = new WeeklyAvailabilityService(async ({ dateFrom, dateTo }) => {
      asked.push({ dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() });
      return emptySlice;
    });

    await service.forWeek({
      users: [user({ id: 1, timeZone: "Europe/Berlin" }), user({ id: 2, timeZone: "Africa/Lagos" })],
      weekStart: WEEK_START,
    });

    // Berlin is UTC+2 on this date, Lagos UTC+1 all year: the same Monday starts an hour apart.
    expect(asked[0]).toEqual({
      dateFrom: "2026-09-27T22:00:00.000Z",
      dateTo: "2026-10-04T22:00:00.000Z",
    });
    expect(asked[1]).toEqual({
      dateFrom: "2026-09-27T23:00:00.000Z",
      dateTo: "2026-10-04T23:00:00.000Z",
    });
  });

  // A calendar read that threw leaves no busy times behind, so summarizing anyway would report
  // the whole schedule as free and the provider as wide open.
  it("blanks the derived figures when the calendar could not be read", async () => {
    const service = new WeeklyAvailabilityService(async () => ({
      scheduledDateRanges: [workday("2026-09-28")],
      busy: [],
      calendarFetchFailed: true,
    }));

    const result = await service.forWeek({ users: [user()], weekStart: WEEK_START });

    expect(result["1"]).toEqual({
      source: "live",
      scheduledMinutes: 480,
      blockedMinutes: null,
      bookedMinutes: null,
      capacityMinutes: null,
      freeMinutes: null,
      calendarConnected: true,
      calendarFetchFailed: true,
    });
  });

  it("reports figures for a provider with no connected calendar", async () => {
    const service = new WeeklyAvailabilityService(async () => ({
      scheduledDateRanges: [workday("2026-09-28")],
      busy: [
        {
          start: "2026-09-28T09:00:00.000Z",
          end: "2026-09-28T10:00:00.000Z",
          source: "eventType-7-booking-42",
        },
      ],
      calendarFetchFailed: false,
    }));

    const result = await service.forWeek({
      users: [user({ hasCalendarCredentials: false })],
      weekStart: WEEK_START,
    });

    expect(result["1"]).toMatchObject({
      scheduledMinutes: 480,
      blockedMinutes: 0,
      bookedMinutes: 60,
      capacityMinutes: 480,
      calendarConnected: false,
    });
  });

  it("keeps one provider's failure from emptying the rest of the board", async () => {
    const service = new WeeklyAvailabilityService(async ({ user: forUser }) => {
      if (forUser.id === 1) throw new Error("credential decryption failed");
      return { scheduledDateRanges: [workday("2026-09-28")], busy: [], calendarFetchFailed: false };
    });

    const result = await service.forWeek({
      users: [user({ id: 1 }), user({ id: 2 })],
      weekStart: WEEK_START,
    });

    expect(result["1"]).toEqual({
      source: "live",
      scheduledMinutes: 0,
      blockedMinutes: null,
      bookedMinutes: null,
      capacityMinutes: null,
      freeMinutes: null,
      calendarConnected: true,
      calendarFetchFailed: true,
    });
    expect(result["2"]).toMatchObject({ scheduledMinutes: 480, freeMinutes: 480 });
  });
});
