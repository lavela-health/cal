import type { Dayjs } from "@calcom/dayjs";
import dayjs from "@calcom/dayjs";
import { summarizeAvailability } from "@calcom/features/availability/lib/summarizeAvailability";
import { buildDateRanges } from "@calcom/features/schedules/lib/date-ranges";
import type { ScheduleVersionAvailability } from "@calcom/features/schedules/repositories/ScheduleVersionRepository";
import type { WeeklyAvailabilityUser, WeeklyHours } from "./WeeklyAvailabilityService";

type RecordedSchedule = {
  availability: ScheduleVersionAvailability[];
  timeZone: string | null;
};

type RecordedBooking = {
  id: number;
  eventTypeId: number | null;
  startTime: Date;
  endTime: Date;
};

type RecordedWeeklyAvailabilityDeps<TUser extends WeeklyAvailabilityUser> = {
  /** The schedule as it stood on the week's first day, or null when nothing was captured. */
  readSnapshot: (args: { user: TUser; asOf: Date }) => Promise<RecordedSchedule | null>;
  readBookings: (args: { user: TUser; dateFrom: Dayjs; dateTo: Dayjs }) => Promise<RecordedBooking[]>;
};

const DAYS_PER_WEEK = 7;

const unrecorded = (user: WeeklyAvailabilityUser): WeeklyHours => ({
  source: "unrecorded",
  scheduledMinutes: null,
  blockedMinutes: null,
  bookedMinutes: null,
  capacityMinutes: null,
  freeMinutes: null,
  calendarConnected: user.hasCalendarCredentials,
  calendarFetchFailed: false,
});

/**
 * A week that has already passed, rebuilt from what was actually recorded.
 *
 * Scheduled hours come from schedule history and booked hours from the bookings themselves, so
 * both are genuinely historical. External-calendar blocks are not: a free/busy query answers
 * for the calendar as it stands today, with since-deleted events simply gone, so everything
 * derived from them stays null rather than being quietly approximated.
 *
 * Two asymmetries against the live path, both following the day grid's recorded path:
 * out-of-office is not versioned, so it is not subtracted here although it is subtracted live;
 * and travel schedules are not versioned either, so none are applied.
 */
class RecordedWeeklyAvailabilityService<TUser extends WeeklyAvailabilityUser> {
  constructor(private readonly deps: RecordedWeeklyAvailabilityDeps<TUser>) {}

  async forWeek({
    users,
    weekStart,
  }: {
    users: TUser[];
    weekStart: string;
  }): Promise<Record<string, WeeklyHours>> {
    const entries = await Promise.all(users.map((user) => this.forUser(user, weekStart)));
    return Object.fromEntries(entries);
  }

  private async forUser(user: TUser, weekStart: string): Promise<[string, WeeklyHours]> {
    const snapshot = await this.deps.readSnapshot({
      user,
      asOf: dayjs.utc(`${weekStart}T00:00:00.000Z`).toDate(),
    });

    if (!snapshot) {
      return [String(user.id), unrecorded(user)];
    }

    // The snapshot's own timezone wins: a provider who has since moved would otherwise have
    // that week rebuilt against today's offset (integration doc §6).
    const timeZone = snapshot.timeZone || user.timeZone;
    const dateFrom = dayjs.tz(`${weekStart}T00:00`, timeZone);
    const dateTo = dateFrom.add(DAYS_PER_WEEK, "day");

    const { dateRanges } = buildDateRanges({
      dateFrom,
      dateTo,
      availability: snapshot.availability,
      timeZone,
      travelSchedules: [],
    });

    const bookings = await this.deps.readBookings({ user, dateFrom, dateTo });
    const { scheduledMinutes, bookedMinutes } = summarizeAvailability({
      scheduled: dateRanges,
      busy: bookings.map((bookedSlot) => ({
        start: bookedSlot.startTime,
        end: bookedSlot.endTime,
        source: `eventType-${bookedSlot.eventTypeId}-booking-${bookedSlot.id}`,
      })),
    });

    return [
      String(user.id),
      {
        source: "recorded",
        scheduledMinutes,
        bookedMinutes,
        blockedMinutes: null,
        capacityMinutes: null,
        freeMinutes: null,
        // Today's connection state, not the week's: nothing records when a calendar was linked.
        calendarConnected: user.hasCalendarCredentials,
        calendarFetchFailed: false,
      },
    ];
  }
}

export { RecordedWeeklyAvailabilityService };
export type { RecordedBooking, RecordedSchedule };
