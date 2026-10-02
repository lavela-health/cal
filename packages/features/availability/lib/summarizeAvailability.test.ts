import dayjs from "@calcom/dayjs";
import type { DateRange } from "@calcom/features/schedules/lib/date-ranges";
import { describe, expect, it } from "vitest";
import { summarizeAvailability } from "./summarizeAvailability";

const monday = "2026-09-28";

const range = (start: string, end: string): DateRange => ({
  start: dayjs.utc(`${monday}T${start}:00.000Z`),
  end: dayjs.utc(`${monday}T${end}:00.000Z`),
});

const busy = (
  start: string,
  end: string,
  source?: string | null
): { start: string; end: string; source?: string | null } => ({
  start: `${monday}T${start}:00.000Z`,
  end: `${monday}T${end}:00.000Z`,
  source,
});

const booking = (start: string, end: string): ReturnType<typeof busy> =>
  busy(start, end, "eventType-7-booking-42");
const calendarBlock = (start: string, end: string): ReturnType<typeof busy> =>
  busy(start, end, "busy_time.calendar");

describe("summarizeAvailability", () => {
  it("reports the whole schedule as capacity when nothing is busy", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [],
    });

    expect(summary).toEqual({
      scheduledMinutes: 480,
      blockedMinutes: 0,
      bookedMinutes: 0,
      capacityMinutes: 480,
      freeMinutes: 480,
    });
  });

  it("treats a calendar block inside the schedule as lost capacity", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [calendarBlock("11:00", "12:30")],
    });

    expect(summary.blockedMinutes).toBe(90);
    expect(summary.capacityMinutes).toBe(390);
    expect(summary.freeMinutes).toBe(390);
    expect(summary.scheduledMinutes).toBe(480);
  });

  it("ignores a calendar block that falls outside working hours", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [calendarBlock("03:00", "04:00")],
    });

    expect(summary.blockedMinutes).toBe(0);
    expect(summary.capacityMinutes).toBe(480);
  });

  it("counts overlapping calendar blocks once", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [calendarBlock("11:00", "13:00"), calendarBlock("12:00", "14:00")],
    });

    expect(summary.blockedMinutes).toBe(180);
    expect(summary.capacityMinutes).toBe(300);
  });

  it("clips a calendar block that extends past the end of the schedule", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [calendarBlock("16:00", "23:00")],
    });

    expect(summary.blockedMinutes).toBe(60);
    expect(summary.capacityMinutes).toBe(420);
  });

  it("counts a booking as consumed capacity, not as lost capacity", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [booking("10:00", "11:00")],
    });

    expect(summary.bookedMinutes).toBe(60);
    expect(summary.freeMinutes).toBe(420);
    expect(summary.capacityMinutes).toBe(480);
    expect(summary.blockedMinutes).toBe(0);
  });

  // Lavela sessions are written into the provider's own connected calendar (integration doc
  // §6), so the same hour arrives twice: once as a booking and once as a calendar event.
  it("does not double-count a booking mirrored into the connected calendar", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [booking("10:00", "11:00"), calendarBlock("10:00", "11:00")],
    });

    expect(summary.bookedMinutes).toBe(60);
    expect(summary.capacityMinutes).toBe(480);
    expect(summary.blockedMinutes).toBe(0);
  });

  it("separates the overlap when a calendar block only partly covers a booking", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [booking("10:00", "11:00"), calendarBlock("10:30", "12:00")],
    });

    expect(summary.bookedMinutes).toBe(60);
    expect(summary.freeMinutes).toBe(360);
    expect(summary.capacityMinutes).toBe(420);
    expect(summary.blockedMinutes).toBe(60);
  });

  it("clips a booking that outlived a shortened schedule", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [booking("16:00", "18:00")],
    });

    expect(summary.bookedMinutes).toBe(60);
    expect(summary.capacityMinutes).toBe(480);
    expect(summary.freeMinutes).toBe(420);
  });

  // withSource must be requested of getUserAvailability; if it ever stops being passed, every
  // booking silently becomes a calendar block. Reading as lost capacity is the safer failure.
  it("treats a busy interval with no source as a calendar block", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "17:00")],
      busy: [busy("10:00", "11:00")],
    });

    expect(summary.bookedMinutes).toBe(0);
    expect(summary.blockedMinutes).toBe(60);
    expect(summary.capacityMinutes).toBe(420);
  });

  // A guard, not a driver: measuring real intervals already handles this, but a refactor to
  // wall-clock hour arithmetic would silently lose the extra hour and nothing else would catch it.
  it("measures real elapsed time across a DST transition", () => {
    const summary = summarizeAvailability({
      scheduled: [
        {
          start: dayjs.tz("2026-10-24T23:00", "Europe/Berlin"),
          end: dayjs.tz("2026-10-25T07:00", "Europe/Berlin"),
        },
      ],
      busy: [],
    });

    expect(summary.scheduledMinutes).toBe(540);
  });

  it("sums several scheduled ranges across the week", () => {
    const summary = summarizeAvailability({
      scheduled: [range("09:00", "12:00"), range("13:00", "17:00")],
      busy: [calendarBlock("11:00", "14:00")],
    });

    expect(summary.scheduledMinutes).toBe(420);
    expect(summary.blockedMinutes).toBe(120);
    expect(summary.capacityMinutes).toBe(300);
  });
});
