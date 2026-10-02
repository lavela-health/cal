import type { Dayjs } from "@calcom/dayjs";
import dayjs from "@calcom/dayjs";
import type { AvailabilityBusyInterval } from "@calcom/features/availability/lib/summarizeAvailability";
import { summarizeAvailability } from "@calcom/features/availability/lib/summarizeAvailability";
import type { DateRange } from "@calcom/features/schedules/lib/date-ranges";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";

const log = logger.getSubLogger({ prefix: ["WeeklyAvailabilityService"] });

type WeeklyAvailabilityUser = {
  id: number;
  timeZone: string;
  /** Whether there was a calendar to subtract at all. Without one the figures are schedule-only. */
  hasCalendarCredentials: boolean;
};

/** The part of a `getUserAvailability` result this service reads. */
type WeeklyAvailabilitySlice = {
  scheduledDateRanges: DateRange[];
  busy: AvailabilityBusyInterval[];
  calendarFetchFailed: boolean;
};

type WeeklyAvailabilityReader<TUser extends WeeklyAvailabilityUser> = (args: {
  user: TUser;
  dateFrom: Dayjs;
  dateTo: Dayjs;
}) => Promise<WeeklyAvailabilitySlice>;

/**
 * Where the week's figures came from, mirroring `availabilitySource` on the day grid:
 * "live" computed now, "recorded" reconstructed from schedule history, "unrecorded" means no
 * record exists for that week and the row asserts nothing (integration doc §6, invariant 15).
 */
type WeeklyHoursSource = "live" | "recorded" | "unrecorded";

type WeeklyHours = {
  source: WeeklyHoursSource;
  /** Null only when nothing was recorded for the week; zero means a genuinely empty schedule. */
  scheduledMinutes: number | null;
  /** Null whenever the calendar could not be read: unknown, which is not the same as zero. */
  blockedMinutes: number | null;
  bookedMinutes: number | null;
  capacityMinutes: number | null;
  freeMinutes: number | null;
  calendarConnected: boolean;
  calendarFetchFailed: boolean;
};

const DAYS_PER_WEEK = 7;

class WeeklyAvailabilityService<TUser extends WeeklyAvailabilityUser> {
  constructor(private readonly read: WeeklyAvailabilityReader<TUser>) {}

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
    // The week is bounded in the provider's own timezone, so a row describes that provider's
    // Monday rather than the viewer's. Two rows therefore cover slightly different absolute
    // windows, which is correct per provider and why the column should not be summed.
    const dateFrom = dayjs.tz(`${weekStart}T00:00`, user.timeZone);
    const dateTo = dateFrom.add(DAYS_PER_WEEK, "day");

    const slice = await this.readSlice({ user, dateFrom, dateTo });

    if (slice.calendarFetchFailed) {
      return [String(user.id), this.unknown(user, slice.scheduledDateRanges)];
    }

    return [
      String(user.id),
      {
        source: "live",
        ...summarizeAvailability({ scheduled: slice.scheduledDateRanges, busy: slice.busy }),
        calendarConnected: user.hasCalendarCredentials,
        calendarFetchFailed: false,
      },
    ];
  }

  // One provider's unreadable calendar must not take the page down or, worse, silently report
  // them as having no availability. `getUserAvailability` already absorbs calendar errors into
  // its own flag; this catches everything coarser, such as a credential that will not decrypt.
  private async readSlice(args: {
    user: TUser;
    dateFrom: Dayjs;
    dateTo: Dayjs;
  }): Promise<WeeklyAvailabilitySlice> {
    try {
      return await this.read(args);
    } catch (error) {
      log.warn(
        "Could not read a provider's availability for the week",
        safeStringify({ userId: args.user.id, error })
      );
      return { scheduledDateRanges: [], busy: [], calendarFetchFailed: true };
    }
  }

  private unknown(user: TUser, scheduled: DateRange[]): WeeklyHours {
    return {
      source: "live",
      scheduledMinutes: summarizeAvailability({ scheduled, busy: [] }).scheduledMinutes,
      blockedMinutes: null,
      bookedMinutes: null,
      capacityMinutes: null,
      freeMinutes: null,
      calendarConnected: user.hasCalendarCredentials,
      calendarFetchFailed: true,
    };
  }
}

export { WeeklyAvailabilityService };
export type { WeeklyAvailabilitySlice, WeeklyAvailabilityUser, WeeklyHours, WeeklyHoursSource };
