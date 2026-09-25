import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import dayjs from "@calcom/dayjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcSessionUser } from "../../../../types";
import { listTeamAvailabilityHandler } from "./listTeamAvailability.handler";

vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: vi.fn().mockImplementation(function () {
    return {
      // Pass users through unchanged: the OAuth-filter suite below only ever supplies an
      // empty membership list, and the past-dates suite needs its fixture user (with the
      // `profile` it set) to survive enrichment so `result.rows[0]` is populated.
      enrichUsersWithTheirProfileExcludingOrgMetadata: vi
        .fn()
        .mockImplementation((users) => Promise.resolve(users)),
    };
  }),
}));

const ORG_ID = 7;
const CLIENT_ID = "cli_prod";

const ctxUser = (overrides: Partial<NonNullable<TrpcSessionUser>> = {}) =>
  ({
    id: 1,
    organizationId: ORG_ID,
    ...overrides,
  }) as NonNullable<TrpcSessionUser>;

const input = (overrides: Record<string, unknown> = {}) => ({
  limit: 10,
  cursor: null,
  startDate: "2026-09-09T00:00:00.000Z",
  endDate: "2026-09-09T23:59:59.000Z",
  loggedInUsersTz: "UTC",
  ...overrides,
});

describe("listTeamAvailabilityHandler — OAuth client filter", () => {
  beforeEach(() => {
    prismaMock.membership.findUnique.mockResolvedValue({ id: 1, role: "OWNER" });
    prismaMock.membership.count.mockResolvedValue(0);
    prismaMock.membership.findMany.mockResolvedValue([]);
    prismaMock.platformOAuthClient.findUnique.mockResolvedValue({ organizationId: ORG_ID });
  });

  it("applies the client filter to the member query", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ oAuthClientId: CLIENT_ID }),
    });

    const where = prismaMock.membership.findMany.mock.calls[0][0].where;
    expect(where.user).toEqual({ platformOAuthClients: { some: { id: CLIENT_ID } } });
  });

  it("applies the client filter to the count query", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ oAuthClientId: CLIENT_ID }),
    });

    const where = prismaMock.membership.count.mock.calls[0][0].where;
    expect(where.user).toEqual({ platformOAuthClients: { some: { id: CLIENT_ID } } });
  });

  it("leaves both queries unfiltered when no client is given", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input(),
    });

    expect(prismaMock.membership.findMany.mock.calls[0][0].where.user).toBeUndefined();
    expect(prismaMock.membership.count.mock.calls[0][0].where.user).toBeUndefined();
  });

  it("rejects a MEMBER who passes an oAuthClientId", async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ id: 1, role: "MEMBER" });

    await expect(
      listTeamAvailabilityHandler({
        ctx: { user: ctxUser() },
        input: input({ oAuthClientId: CLIENT_ID }),
      })
    ).rejects.toThrow(/owners and admins/i);
  });

  it("rejects an unknown client", async () => {
    prismaMock.platformOAuthClient.findUnique.mockResolvedValue(null);

    await expect(
      listTeamAvailabilityHandler({
        ctx: { user: ctxUser() },
        input: input({ oAuthClientId: CLIENT_ID }),
      })
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a caller with no membership in the client's organization", async () => {
    prismaMock.membership.findUnique.mockResolvedValue(null);

    await expect(
      listTeamAvailabilityHandler({
        ctx: { user: ctxUser() },
        input: input({ oAuthClientId: CLIENT_ID }),
      })
    ).rejects.toThrow(/owners and admins/i);
  });

  it("checks membership against the client's organization, not the session's", async () => {
    // A stale session carries no organizationId; authorization must still resolve.
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser({ organizationId: null }) },
      input: input({ oAuthClientId: CLIENT_ID }),
    });

    expect(prismaMock.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_teamId: { userId: 1, teamId: ORG_ID } },
      select: { role: true },
    });
  });

  it("scopes the listing to the client's organization when the session has none", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser({ organizationId: null }) },
      input: input({ oAuthClientId: CLIENT_ID }),
    });

    expect(prismaMock.membership.count.mock.calls[0][0].where.teamId).toBe(ORG_ID);
  });

  it("runs no authorization queries when no client is given", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input(),
    });

    expect(prismaMock.platformOAuthClient.findUnique).not.toHaveBeenCalled();
  });
});

describe("listTeamAvailabilityHandler — past dates", () => {
  const PAST = { startDate: "2026-08-14T00:00:00.000Z", endDate: "2026-08-14T23:59:59.000Z" };

  const member = {
    id: 1,
    role: "MEMBER",
    user: {
      id: 11,
      name: "Aretha Hampton",
      username: "aretha",
      email: "aretha@example.com",
      timeZone: "Europe/London",
      defaultScheduleId: 99,
      travelSchedules: [],
      profile: null,
    },
  };

  beforeEach(() => {
    prismaMock.membership.findUnique.mockResolvedValue({ id: 1, role: "OWNER" });
    prismaMock.membership.count.mockResolvedValue(1);
    prismaMock.membership.findMany.mockResolvedValue([member]);
    prismaMock.platformOAuthClient.findUnique.mockResolvedValue({ organizationId: ORG_ID });
    prismaMock.schedule.findUnique.mockResolvedValue({
      timeZone: "Europe/London",
      availability: [
        {
          days: [1, 2, 3, 4, 5],
          startTime: new Date("1970-01-01T09:00:00.000Z"),
          endTime: new Date("1970-01-01T17:00:00.000Z"),
          date: null,
        },
      ],
    });
  });

  // Review Focus 1: the motivating case. August predates capture, so there is no version —
  // and reporting today's live rows there is the exact bug this feature removes.
  it("reports unrecorded, not live rows, for a past date with no version", async () => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue(null);

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ ...PAST, oAuthClientId: CLIENT_ID }),
    });

    expect(result.rows[0].availabilitySource).toBe("unrecorded");
    expect(result.rows[0].dateRanges).toEqual([]);
    expect(prismaMock.schedule.findUnique).not.toHaveBeenCalled();
  });

  // Review Focus 2: a recorded empty schedule is a real answer and must not read as a gap.
  it("distinguishes a recorded empty schedule from an unrecorded date", async () => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue({ timeZone: "Europe/London", availability: [] });

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ ...PAST, oAuthClientId: CLIENT_ID }),
    });

    expect(result.rows[0].availabilitySource).toBe("recorded");
    expect(result.rows[0].dateRanges).toEqual([]);
  });

  it("reconstructs from the recorded version rather than the live schedule", async () => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue({
      timeZone: "Europe/London",
      availability: [{ days: [5], startTime: "14:00:00", endTime: "16:00:00", date: null }],
    });

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ ...PAST, oAuthClientId: CLIENT_ID }),
    });

    expect(result.rows[0].availabilitySource).toBe("recorded");
    expect(result.rows[0].dateRanges).not.toEqual([]);
    expect(prismaMock.schedule.findUnique).not.toHaveBeenCalled();
  });

  it("uses the timezone recorded at the time, not the current one", async () => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue({
      timeZone: "America/New_York",
      availability: [{ days: [5], startTime: "09:00:00", endTime: "17:00:00", date: null }],
    });

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ ...PAST, oAuthClientId: CLIENT_ID }),
    });

    expect(result.rows[0].timeZone).toBe("America/New_York");
  });

  it("still reads live rows for today", async () => {
    const today = dayjs().startOf("day");

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({
        startDate: today.toISOString(),
        endDate: today.endOf("day").toISOString(),
        oAuthClientId: CLIENT_ID,
      }),
    });

    expect(result.rows[0].availabilitySource).toBe("live");
    expect(prismaMock.scheduleVersion.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.schedule.findUnique).toHaveBeenCalled();
  });

  // "Today" must be the caller's today, not the server's. The process runs TZ=UTC, but a
  // caller ahead of UTC has a local midnight that lands before UTC midnight for part of the
  // UTC day — comparing the requested date against server-local midnight would misclassify a
  // live, working schedule as unrecorded for exactly that caller, exactly then. That window
  // (before 15:00 UTC for Asia/Tokyo, UTC+9) doesn't hold for the whole day, so the clock is
  // pinned rather than left to wall-clock chance — a run outside that window would pass
  // whether or not the bug were present, and prove nothing.
  it("still reads live rows for today in a timezone ahead of UTC", async () => {
    const tz = "Asia/Tokyo";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T02:00:00.000Z"));

    try {
      const todayInTz = dayjs().tz(tz).startOf("day");

      const result = await listTeamAvailabilityHandler({
        ctx: { user: ctxUser() },
        input: input({
          startDate: todayInTz.toISOString(),
          endDate: todayInTz.endOf("day").toISOString(),
          loggedInUsersTz: tz,
          oAuthClientId: CLIENT_ID,
        }),
      });

      expect(result.rows[0].availabilitySource).toBe("live");
      expect(prismaMock.scheduleVersion.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.schedule.findUnique).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Review Focus 3 (added): the Task 2 unit test labelled "DST" never actually exercised DST
  // reconstruction, because its time mapping read neither date nor timezone. This is the seam
  // where a recorded timezone and a real past date meet, so pin it here: Europe/London sits at
  // UTC+1 (BST) in August and UTC+0 (GMT) in December, and reconstruction must apply whichever
  // offset was in effect on the requested date, not today's.
  it.each([
    {
      label: "BST offset in August",
      startDate: "2026-08-14T00:00:00.000Z",
      endDate: "2026-08-14T23:59:59.000Z",
      expectedStart: "2026-08-14T08:00:00.000Z",
      expectedEnd: "2026-08-14T16:00:00.000Z",
    },
    {
      label: "GMT offset in December",
      startDate: "2026-12-11T00:00:00.000Z",
      endDate: "2026-12-11T23:59:59.000Z",
      expectedStart: "2026-12-11T09:00:00.000Z",
      expectedEnd: "2026-12-11T17:00:00.000Z",
    },
  ])("reconstructs the correct absolute instants for a recorded Europe/London schedule ($label)", async ({
    startDate,
    endDate,
    expectedStart,
    expectedEnd,
  }) => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue({
      timeZone: "Europe/London",
      availability: [{ days: [5], startTime: "09:00:00", endTime: "17:00:00", date: null }],
    });

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ startDate, endDate, oAuthClientId: CLIENT_ID }),
    });

    const requestedDay = startDate.slice(0, 10);
    const range = result.rows[0].dateRanges.find((r) => dayjs(r.start).format("YYYY-MM-DD") === requestedDay);

    expect(range).toBeDefined();
    expect(dayjs(range?.start).toISOString()).toBe(expectedStart);
    expect(dayjs(range?.end).toISOString()).toBe(expectedEnd);
  });
});
