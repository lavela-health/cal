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

    return {
      timeZone: version.timeZone,
      availability: (version.availability as StoredAvailability[]).map(toAvailability),
    };
  }
}
