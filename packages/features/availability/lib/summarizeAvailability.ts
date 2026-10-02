import dayjs from "@calcom/dayjs";
import type { DateRange } from "@calcom/features/schedules/lib/date-ranges";
import { subtract } from "@calcom/features/schedules/lib/date-ranges";

type AvailabilityBusyInterval = {
  start: string | Date;
  end: string | Date;
  source?: string | null;
};

type AvailabilitySummary = {
  scheduledMinutes: number;
  blockedMinutes: number;
  bookedMinutes: number;
  capacityMinutes: number;
  freeMinutes: number;
};

const MS_PER_MINUTE = 60 * 1000;

function totalMinutes(ranges: DateRange[]): number {
  const ms = ranges.reduce((sum, { start, end }) => sum + Math.max(0, end.valueOf() - start.valueOf()), 0);
  return Math.round(ms / MS_PER_MINUTE);
}

// getBusyTimes labels booking-derived intervals `eventType-{id}-booking-{id}` and everything
// calendar-derived `busy_time.calendar`. Matching on the booking shape rather than on the
// calendar one means an unrecognised source is read as lost capacity, which understates a
// provider rather than inventing capacity for them.
function isBooking(interval: AvailabilityBusyInterval): boolean {
  return !!interval.source?.includes("-booking-");
}

function toRange(interval: AvailabilityBusyInterval): DateRange {
  return { start: dayjs(interval.start), end: dayjs(interval.end) };
}

/**
 * Splits a provider's scheduled time into what the connected calendar took, what bookings
 * took, and what is left.
 *
 * Every figure is measured against the schedule rather than summed from the intervals
 * themselves, which is what makes overlapping blocks count once, a block outside working hours
 * count not at all, and a booking that outlived a shortened schedule stay clipped to it.
 */
function summarizeAvailability({
  scheduled,
  busy,
}: {
  scheduled: DateRange[];
  busy: AvailabilityBusyInterval[];
}): AvailabilitySummary {
  const scheduledMinutes = totalMinutes(scheduled);
  const freeMinutes = totalMinutes(subtract(scheduled, busy.map(toRange)));
  const bookedMinutes =
    scheduledMinutes - totalMinutes(subtract(scheduled, busy.filter(isBooking).map(toRange)));
  // Capacity is derived from free + booked, not from schedule minus calendar blocks, because a
  // Lavela session is written into the provider's own calendar too (integration doc §6). The
  // subtraction would count that hour as capacity the provider never offered.
  const capacityMinutes = freeMinutes + bookedMinutes;

  return {
    scheduledMinutes,
    blockedMinutes: scheduledMinutes - capacityMinutes,
    bookedMinutes,
    capacityMinutes,
    freeMinutes,
  };
}

export { summarizeAvailability };
export type { AvailabilityBusyInterval, AvailabilitySummary };
