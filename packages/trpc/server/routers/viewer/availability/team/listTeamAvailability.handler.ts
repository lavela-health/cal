import type { Dayjs } from "@calcom/dayjs";
import dayjs from "@calcom/dayjs";
import type { DateRange } from "@calcom/features/schedules/lib/date-ranges";
import { buildDateRanges } from "@calcom/features/schedules/lib/date-ranges";
import type { ScheduleVersionAvailability } from "@calcom/features/schedules/repositories/ScheduleVersionRepository";
import { ScheduleVersionRepository } from "@calcom/features/schedules/repositories/ScheduleVersionRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { prisma } from "@calcom/prisma";
import type { Availability } from "@calcom/prisma/client";
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
  availability: Availability[] | ScheduleVersionAvailability[];
  timeZone: string | null;
  source: AvailabilitySource;
};

async function resolveAvailability(
  defaultScheduleId: number,
  dateFrom: Dayjs
): Promise<ResolvedAvailability | null> {
  // The caller pads dateFrom back by a day to catch timezone-shifted boundary slots in
  // buildDateRanges. That buffer would otherwise make "today" look like "yesterday" here and
  // wrongly route it through the recorded-history path, so recover the actual requested day
  // before deciding what "past" means and before querying a version "as of" it.
  const requestedDate = dateFrom.add(1, "day");

  if (!requestedDate.isBefore(dayjs().startOf("day"))) {
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

async function buildMember(member: Member, dateFrom: Dayjs, dateTo: Dayjs) {
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
      // No schedule is a present-tense fact, not a gap in history.
      availabilitySource: "live" as AvailabilitySource,
    };
  }

  const resolved = await resolveAvailability(member.user.defaultScheduleId, dateFrom);
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

  const buildMembers = teamMembers?.map((member) => buildMember(member, dateFrom, dateTo));

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
