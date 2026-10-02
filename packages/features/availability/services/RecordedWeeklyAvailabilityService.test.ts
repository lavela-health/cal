import { describe, expect, it } from "vitest";
import { RecordedWeeklyAvailabilityService } from "./RecordedWeeklyAvailabilityService";
import type { WeeklyAvailabilityUser } from "./WeeklyAvailabilityService";

const WEEK_START = "2026-09-21";

const user = (overrides?: Partial<WeeklyAvailabilityUser>): WeeklyAvailabilityUser => ({
  id: 1,
  timeZone: "UTC",
  hasCalendarCredentials: true,
  ...overrides,
});

// Mondays and Tuesdays, 09:00-17:00.
const twoDaySchedule = [
  {
    days: [1, 2],
    startTime: new Date("1970-01-01T09:00:00.000Z"),
    endTime: new Date("1970-01-01T17:00:00.000Z"),
    date: null,
  },
];

describe("RecordedWeeklyAvailabilityService", () => {
  it("reconstructs scheduled hours and measures bookings against them", async () => {
    const service = new RecordedWeeklyAvailabilityService({
      readSnapshot: async () => ({ availability: twoDaySchedule, timeZone: "UTC" }),
      readBookings: async () => [
        {
          id: 42,
          eventTypeId: 7,
          startTime: new Date("2026-09-21T10:00:00.000Z"),
          endTime: new Date("2026-09-21T11:00:00.000Z"),
        },
      ],
    });

    const result = await service.forWeek({ users: [user()], weekStart: WEEK_START });

    expect(result["1"]).toEqual({
      source: "recorded",
      scheduledMinutes: 960,
      bookedMinutes: 60,
      // Nothing recorded the provider's external calendar for a week already past, so these
      // stay unknown rather than being computed from a calendar that has since moved on.
      blockedMinutes: null,
      capacityMinutes: null,
      freeMinutes: null,
      calendarConnected: true,
      calendarFetchFailed: false,
    });
  });

  it("reports a week with no snapshot as unrecorded rather than as empty", async () => {
    const service = new RecordedWeeklyAvailabilityService({
      readSnapshot: async () => null,
      readBookings: async () => [],
    });

    const result = await service.forWeek({ users: [user()], weekStart: WEEK_START });

    expect(result["1"]).toEqual({
      source: "unrecorded",
      scheduledMinutes: null,
      blockedMinutes: null,
      bookedMinutes: null,
      capacityMinutes: null,
      freeMinutes: null,
      calendarConnected: true,
      calendarFetchFailed: false,
    });
  });

  it("reconstructs the week in the timezone the snapshot carried", async () => {
    const asked: { dateFrom: string; dateTo: string }[] = [];
    const service = new RecordedWeeklyAvailabilityService({
      readSnapshot: async () => ({ availability: twoDaySchedule, timeZone: "Africa/Lagos" }),
      readBookings: async ({ dateFrom, dateTo }) => {
        asked.push({ dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() });
        return [];
      },
    });

    await service.forWeek({ users: [user({ timeZone: "Europe/Berlin" })], weekStart: WEEK_START });

    // Lagos is UTC+1: the snapshot's timezone wins over the provider's current one, or a
    // provider who has since moved has their history rebuilt against the wrong offset.
    expect(asked[0].dateFrom).toBe("2026-09-20T23:00:00.000Z");
  });

  it("falls back to the provider's current timezone when the snapshot carried none", async () => {
    const asked: string[] = [];
    const service = new RecordedWeeklyAvailabilityService({
      readSnapshot: async () => ({ availability: twoDaySchedule, timeZone: null }),
      readBookings: async ({ dateFrom }) => {
        asked.push(dateFrom.toISOString());
        return [];
      },
    });

    await service.forWeek({ users: [user({ timeZone: "Africa/Lagos" })], weekStart: WEEK_START });

    expect(asked[0]).toBe("2026-09-20T23:00:00.000Z");
  });

  it("clips a booking that ran past the recorded schedule", async () => {
    const service = new RecordedWeeklyAvailabilityService({
      readSnapshot: async () => ({ availability: twoDaySchedule, timeZone: "UTC" }),
      readBookings: async () => [
        {
          id: 1,
          eventTypeId: 7,
          startTime: new Date("2026-09-21T16:00:00.000Z"),
          endTime: new Date("2026-09-21T18:00:00.000Z"),
        },
      ],
    });

    const result = await service.forWeek({ users: [user()], weekStart: WEEK_START });

    expect(result["1"]).toMatchObject({ scheduledMinutes: 960, bookedMinutes: 60 });
  });
});
