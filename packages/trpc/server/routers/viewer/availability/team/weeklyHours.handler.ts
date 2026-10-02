import { enrichUsersWithDelegationCredentials } from "@calcom/app-store/delegationCredential";
import dayjs from "@calcom/dayjs";
import { RecordedWeeklyAvailabilityService } from "@calcom/features/availability/services/RecordedWeeklyAvailabilityService";
import type { WeeklyHours } from "@calcom/features/availability/services/WeeklyAvailabilityService";
import { WeeklyAvailabilityService } from "@calcom/features/availability/services/WeeklyAvailabilityService";
import { BookingRepository } from "@calcom/features/bookings/repositories/BookingRepository";
import { getUserAvailabilityService } from "@calcom/features/di/containers/GetUserAvailability";
import { ScheduleVersionRepository } from "@calcom/features/schedules/repositories/ScheduleVersionRepository";
import { withSelectedCalendars } from "@calcom/lib/server/withSelectedCalendars";
import { availabilityUserSelect, prisma } from "@calcom/prisma";
import { credentialForCalendarServiceSelect } from "@calcom/prisma/selects/credential";
import type { TrpcSessionUser } from "../../../../types";
import { resolveOAuthClientOrganization } from "./resolveOAuthClientOrganization";
import type { TWeeklyHoursInputSchema } from "./weeklyHours.schema";

type GetOptions = {
  ctx: { user: NonNullable<TrpcSessionUser> };
  input: TWeeklyHoursInputSchema;
};

const DAYS_PER_WEEK = 7;

/**
 * A week is past once it has ended in the caller's own day. Comparing against the server's
 * midnight would route the current week down the recorded path for any caller ahead of UTC,
 * reporting history for a week still being lived.
 */
function isPastWeek(weekStart: string, timeZone: string): boolean {
  const weekEnd = dayjs.tz(`${weekStart}T00:00`, timeZone).add(DAYS_PER_WEEK, "day");
  return weekEnd.valueOf() <= dayjs().tz(timeZone).startOf("day").valueOf();
}

// Scoping by the client as well as the ids keeps a caller from probing users outside it.
async function findUsers({
  userIds,
  oAuthClientId,
  organizationId,
}: {
  userIds: number[];
  oAuthClientId: string;
  organizationId: number;
}) {
  const users = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      platformOAuthClients: { some: { id: oAuthClientId } },
    },
    select: {
      ...availabilityUserSelect,
      selectedCalendars: true,
      credentials: { select: credentialForCalendarServiceSelect },
    },
  });

  const enriched = await enrichUsersWithDelegationCredentials({
    orgId: organizationId,
    users: users.map(withSelectedCalendars),
  });

  return enriched.map((user) => ({
    ...user,
    // Mirrors the gate getBusyTimes uses before it reads any calendar at all, so "connected"
    // means the same thing here as it does to the subtraction.
    hasCalendarCredentials: user.credentials.length > 0,
  }));
}

/** Inference from the reader callbacks alone collapses to the constraint, so the services are
 * instantiated against this explicitly. */
type AvailabilityCandidate = Awaited<ReturnType<typeof findUsers>>[number];

export const weeklyHoursHandler = async ({
  ctx,
  input,
}: GetOptions): Promise<Record<string, WeeklyHours>> => {
  // Throws FORBIDDEN unless the caller administers the organization owning the client.
  const organizationId = await resolveOAuthClientOrganization({
    userId: ctx.user.id,
    oAuthClientId: input.oAuthClientId,
  });

  const users = await findUsers({
    userIds: input.userIds,
    oAuthClientId: input.oAuthClientId,
    organizationId,
  });

  if (isPastWeek(input.weekStart, input.loggedInUsersTz)) {
    const scheduleVersions = new ScheduleVersionRepository(prisma);
    const bookings = new BookingRepository(prisma);

    const recorded = new RecordedWeeklyAvailabilityService<AvailabilityCandidate>({
      readSnapshot: async ({ user, asOf }) =>
        user.defaultScheduleId ? scheduleVersions.availabilityAsOf(user.defaultScheduleId, asOf) : null,
      readBookings: async ({ user, dateFrom, dateTo }) => {
        const booked = await bookings.findAllExistingBookingsForEventTypeBetween({
          userIdAndEmailMap: new Map([[user.id, user.email]]),
          startDate: dateFrom.toDate(),
          endDate: dateTo.toDate(),
        });

        return booked.map((entry) => ({
          id: entry.id,
          eventTypeId: entry.eventType?.id ?? null,
          startTime: entry.startTime,
          endTime: entry.endTime,
        }));
      },
    });

    return recorded.forWeek({ users, weekStart: input.weekStart });
  }

  const availability = getUserAvailabilityService();
  const live = new WeeklyAvailabilityService<AvailabilityCandidate>(async ({ user, dateFrom, dateTo }) => {
    const result = await availability.getUserAvailability(
      // withSource is what lets a booking be told apart from a calendar block downstream.
      { dateFrom, dateTo, returnDateOverrides: false, withSource: true },
      { user }
    );

    return {
      scheduledDateRanges: result.scheduledDateRanges,
      busy: result.busy,
      calendarFetchFailed: result.calendarFetchFailed,
    };
  });

  return live.forWeek({ users, weekStart: input.weekStart });
};
