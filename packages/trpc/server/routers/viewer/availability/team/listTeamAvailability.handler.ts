import type { Dayjs } from "@calcom/dayjs";
import dayjs from "@calcom/dayjs";
import type { DateRange } from "@calcom/features/schedules/lib/date-ranges";
import { buildDateRanges } from "@calcom/features/schedules/lib/date-ranges";
import type { ScheduleVersionAvailability } from "@calcom/features/schedules/repositories/ScheduleVersionRepository";
import { ScheduleVersionRepository } from "@calcom/features/schedules/repositories/ScheduleVersionRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { prisma } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";
import { TRPCError } from "@trpc/server";
import type { TrpcSessionUser } from "../../../../types";
import type { TListTeamAvailaiblityScheme } from "./listTeamAvailability.schema";
import { resolveOAuthClientOrganization } from "./resolveOAuthClientOrganization";

type GetOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TListTeamAvailaiblityScheme;
};

function buildOAuthClientFilter(oAuthClientId?: string) {
  if (!oAuthClientId) return {};
  return { user: { platformOAuthClients: { some: { id: oAuthClientId } } } };
}

async function getTeamMembers({
  teamId,
  organizationId,
  teamIds,
  cursor,
  limit,
  searchString,
  oAuthClientId,
}: {
  teamId?: number;
  organizationId: number | null;
  teamIds?: number[];
  cursor: number | null | undefined;
  limit: number;
  searchString?: string | null;
  oAuthClientId?: string;
}) {
  const memberships = await prisma.membership.findMany({
    where: {
      teamId: {
        in: teamId ? [teamId] : teamIds,
      },
      ...buildOAuthClientFilter(oAuthClientId),
      ...(searchString
        ? {
            OR: [
              { user: { username: { contains: searchString } } },
              { user: { name: { contains: searchString } } },
              { user: { email: { contains: searchString } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      role: true,
      user: {
        select: {
          avatarUrl: true,
          id: true,
          username: true,
          name: true,
          email: true,
          travelSchedules: true,
          timeZone: true,
          defaultScheduleId: true,
        },
      },
    },
    cursor: cursor ? { id: cursor } : undefined,
    take: limit + 1, // We take +1 as itll be used for the next cursor
    orderBy: [{ userId: "asc" }, { id: "asc" }], // Prisma require a unique field for tie breaking duplicate value for pagination
    distinct: ["userId"],
  });

  const userRepo = new UserRepository(prisma);
  const users = memberships.map((membership) => membership.user);
  const enrichedUsers = await userRepo.enrichUsersWithTheirProfileExcludingOrgMetadata(users);
  const enrichedUserMap = new Map<number, (typeof enrichedUsers)[0]>();
  enrichedUsers.forEach((enrichedUser) => {
    enrichedUserMap.set(enrichedUser.id, enrichedUser);
  });
  const membershipWithUserProfile = [];
  for (const membership of memberships) {
    const enrichedUser = enrichedUserMap.get(membership.user.id);
    if (!enrichedUser) continue;
    membershipWithUserProfile.push({
      ...membership,
      user: enrichedUser,
    });
  }

  return membershipWithUserProfile;
}

type Member = Awaited<ReturnType<typeof getTeamMembers>>[number];

type AvailabilitySource = "live" | "recorded" | "unrecorded";

type ResolvedAvailability = {
  availability: ScheduleVersionAvailability[];
  timeZone: string | null;
  source: AvailabilitySource;
};

// The caller pads dateFrom back by a day to catch timezone-shifted boundary slots in
// buildDateRanges. That buffer would otherwise make "today" look like "yesterday" and wrongly
// route it through the recorded-history path, so recover the actual requested day before
// deciding what "past" means and before querying a version "as of" it.
const requestedDayOf = (dateFrom: Dayjs) => dateFrom.add(1, "day");

// "Today" is the caller's today, not the server's: callerToday is midnight in
// loggedInUsersTz, computed once by the handler. Comparing against server-local midnight
// would misclassify a live, working schedule as "unrecorded" for any caller ahead of UTC,
// whose local today starts before UTC midnight.
const isPastRequest = (dateFrom: Dayjs, callerToday: Dayjs) => requestedDayOf(dateFrom).isBefore(callerToday);

async function resolveAvailability(
  defaultScheduleId: number,
  dateFrom: Dayjs,
  callerToday: Dayjs
): Promise<ResolvedAvailability | null> {
  const requestedDate = requestedDayOf(dateFrom);

  if (!isPastRequest(dateFrom, callerToday)) {
    const schedule = await prisma.schedule.findUnique({
      where: { id: defaultScheduleId },
      select: { availability: true, timeZone: true },
    });
    return {
      availability: schedule?.availability ?? [],
      timeZone: schedule?.timeZone ?? null,
      source: "live",
    };
  }

  const recorded = await new ScheduleVersionRepository(prisma).availabilityAsOf(
    defaultScheduleId,
    requestedDate.toDate()
  );

  // No version covers this date, so it predates capture. Falling back to the live rows here
  // would answer a question about the past with today's data — the failure this exists to fix.
  if (!recorded) {
    return null;
  }

  return { availability: recorded.availability, timeZone: recorded.timeZone, source: "recorded" };
}

async function buildMember(member: Member, dateFrom: Dayjs, dateTo: Dayjs, callerToday: Dayjs) {
  if (!member.user.defaultScheduleId) {
    return {
      id: member.user.id,
      organizationId: member.user.profile?.organizationId ?? null,
      name: member.user.name,
      username: member.user.username,
      email: member.user.email,
      timeZone: member.user.timeZone,
      role: member.role,
      defaultScheduleId: -1,
      dateRanges: [] as DateRange[],
      // Having no schedule is a present-tense fact about today, but it says nothing about a
      // past date: an offboarded provider, a deleted schedule and a nulled defaultScheduleId
      // all land here, and calling that "live" renders an empty row under "Recorded history",
      // asserting a record we never captured (invariant 15).
      availabilitySource: (isPastRequest(dateFrom, callerToday)
        ? "unrecorded"
        : "live") as AvailabilitySource,
    };
  }

  // The range is classified once, by its first day (dateFrom), not per day within it. The
  // only consumer, AvailabilitySliderTable, always requests a single day, so this is correct
  // for the fleet view today. A multi-day range that straddles the live/recorded boundary
  // would report one source for the whole row — deliberately out of scope; per-day
  // classification would mean segmenting dateRanges by day, a larger change than this ticket.
  const resolved = await resolveAvailability(member.user.defaultScheduleId, dateFrom, callerToday);
  const timeZone = resolved?.timeZone || member.user.timeZone;

  const dateRanges = resolved
    ? buildDateRanges({
        dateFrom,
        dateTo,
        timeZone,
        availability: resolved.availability,
        travelSchedules: member.user.travelSchedules.map((schedule) => {
          return {
            startDate: dayjs(schedule.startDate),
            endDate: schedule.endDate ? dayjs(schedule.endDate) : undefined,
            timeZone: schedule.timeZone,
          };
        }),
      }).dateRanges
    : ([] as DateRange[]);

  return {
    id: member.user.id,
    username: member.user.username,
    email: member.user.email,
    avatarUrl: member.user.avatarUrl,
    profile: member.user.profile,
    organizationId: member.user.profile?.organizationId,
    name: member.user.name,
    timeZone,
    role: member.role,
    defaultScheduleId: member.user.defaultScheduleId ?? -1,
    dateRanges,
    availabilitySource: resolved?.source ?? "unrecorded",
  };
}

async function getInfoForAllTeams({ ctx, input }: GetOptions) {
  const { cursor, limit, searchString } = input;

  // Get all teamIds for the user
  const teamIds = await prisma.membership
    .findMany({
      where: {
        userId: ctx.user.id,
      },
      select: {
        id: true,
        teamId: true,
      },
    })
    .then((memberships) => memberships.map((membership) => membership.teamId));

  if (!teamIds.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "User is not part of any organization or team." });
  }

  const teamMembers = await getTeamMembers({
    teamIds,
    organizationId: ctx.user.organizationId,
    cursor,
    limit,
    searchString,
  });

  // Get total team count across all teams the user is in (for pagination)

  const totalTeamMembers = await prisma.$queryRaw<
    {
      count: number;
    }[]
  >`SELECT COUNT(DISTINCT "userId")::integer from "Membership" WHERE "teamId" IN (${Prisma.join(teamIds)})`;

  return {
    teamMembers,
    totalTeamMembers: totalTeamMembers[0].count,
  };
}

export const listTeamAvailabilityHandler = async ({ ctx, input }: GetOptions) => {
  const { cursor, limit, searchString } = input;
  // The client's own organization wins over the session's, which may be stale.
  const teamId = input.oAuthClientId
    ? await resolveOAuthClientOrganization({
        userId: ctx.user.id,
        oAuthClientId: input.oAuthClientId,
      })
    : input.teamId || ctx.user.organizationId;

  let teamMembers: Member[] = [];
  let totalTeamMembers = 0;

  if (!teamId) {
    // Get all users TODO:
    const teamAllInfo = await getInfoForAllTeams({ ctx, input });

    teamMembers = teamAllInfo.teamMembers;
    totalTeamMembers = teamAllInfo.totalTeamMembers;
  } else {
    const isMember = await prisma.membership.findUnique({
      where: {
        userId_teamId: {
          userId: ctx.user.id,
          teamId,
        },
      },
    });

    if (!isMember) {
      teamMembers = [];
      totalTeamMembers = 0;
    } else {
      const { cursor, limit } = input;

      totalTeamMembers = await prisma.membership.count({
        where: {
          teamId: teamId,
          ...buildOAuthClientFilter(input.oAuthClientId),
          ...(searchString
            ? {
                OR: [
                  { user: { username: { contains: searchString } } },
                  { user: { name: { contains: searchString } } },
                  { user: { email: { contains: searchString } } },
                ],
              }
            : {}),
        },
      });

      // I couldnt get this query to work direct on membership table
      teamMembers = await getTeamMembers({
        teamId,
        cursor,
        limit,
        organizationId: ctx.user.organizationId,
        searchString,
        oAuthClientId: input.oAuthClientId,
      });
    }
  }

  let nextCursor: typeof cursor | undefined;
  if (teamMembers && teamMembers.length > limit) {
    const nextItem = teamMembers.pop();
    nextCursor = nextItem?.id;
  }

  const dateFrom = dayjs(input.startDate).tz(input.loggedInUsersTz).subtract(1, "day");
  const dateTo = dayjs(input.endDate).tz(input.loggedInUsersTz).add(1, "day");
  // "Today" for the live/recorded decision is the caller's today, not the server's — compute
  // it once here, in the same timezone as dateFrom/dateTo, rather than per member.
  const callerToday = dayjs().tz(input.loggedInUsersTz).startOf("day");

  const buildMembers = teamMembers?.map((member) => buildMember(member, dateFrom, dateTo, callerToday));

  const members = await Promise.all(buildMembers);

  let belongsToTeam = true;

  if (totalTeamMembers === 0) {
    const membership = await prisma.membership.findFirst({
      where: {
        userId: ctx.user.id,
      },
      select: {
        id: true,
      },
    });
    belongsToTeam = !!membership;
  }

  return {
    rows: members || [],
    nextCursor,
    meta: {
      totalRowCount: totalTeamMembers,
      isApartOfAnyTeam: belongsToTeam,
    },
  };
};
