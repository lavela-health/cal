import logger from "@calcom/lib/logger";
import type { PrismaClient } from "@calcom/prisma";

export type ScheduleVersionAvailability = {
  days: number[];
  startTime: Date;
  endTime: Date;
  date: Date | null;
};

export type ScheduleVersionSnapshot = {
  availability: ScheduleVersionAvailability[];
  timeZone: string | null;
};

type StoredAvailability = {
  days: number[];
  startTime: string;
  endTime: string;
  date: string | null;
};

const log = logger.getSubLogger({ prefix: ["ScheduleVersionRepository"] });

// The trigger writes these, but nothing in the database constrains the JSON's shape, and a
// bad row must not be trusted: a non-array throws inside the caller's Promise.all and 500s
// the whole fleet view, and a malformed time string yields an Invalid Date that
// buildDateRanges silently turns into zero ranges — rendered as a confident "recorded" empty
// day, the conflation invariant 15 forbids.
const WALL_CLOCK_TIME = /^\d{2}:\d{2}:\d{2}$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isStoredAvailability = (value: unknown): value is StoredAvailability => {
  if (typeof value !== "object" || value === null) return false;

  const { days, startTime, endTime, date } = value as Record<string, unknown>;

  return (
    Array.isArray(days) &&
    days.every((day) => typeof day === "number") &&
    typeof startTime === "string" &&
    WALL_CLOCK_TIME.test(startTime) &&
    typeof endTime === "string" &&
    WALL_CLOCK_TIME.test(endTime) &&
    (date === null || (typeof date === "string" && CALENDAR_DATE.test(date)))
  );
};

// buildDateRanges reads wall-clock time off these via getUTCHours()/getUTCMinutes(), matching
// how Prisma surfaces a @db.Time column. Anchoring to the epoch preserves that contract.
const toTime = (value: string) => new Date(`1970-01-01T${value}.000Z`);

const toAvailability = (stored: StoredAvailability): ScheduleVersionAvailability => ({
  days: stored.days,
  startTime: toTime(stored.startTime),
  endTime: toTime(stored.endTime),
  date: stored.date ? new Date(`${stored.date}T00:00:00.000Z`) : null,
});

export class ScheduleVersionRepository {
  constructor(private prismaClient: PrismaClient) {}

  async availabilityAsOf(scheduleId: number, at: Date): Promise<ScheduleVersionSnapshot | null> {
    const version = await this.prismaClient.scheduleVersion.findFirst({
      where: {
        scheduleId,
        validFrom: { lte: at },
        OR: [{ validTo: null }, { validTo: { gt: at } }],
      },
      orderBy: { validFrom: "desc" },
      select: { availability: true, timeZone: true },
    });

    if (!version) {
      return null;
    }

    const stored = version.availability;

    // An unreadable row means we cannot honestly say what was scheduled, and "we don't know"
    // is what the caller resolves null to. Degrading one member to "unrecorded" beats both
    // throwing (which takes the whole page down) and half-mapping (which asserts a record
    // that was never readable).
    if (!Array.isArray(stored) || !stored.every(isStoredAvailability)) {
      log.warn("Discarding a malformed ScheduleVersion snapshot", { scheduleId, at });
      return null;
    }

    return {
      timeZone: version.timeZone,
      availability: stored.map(toAvailability),
    };
  }
}
