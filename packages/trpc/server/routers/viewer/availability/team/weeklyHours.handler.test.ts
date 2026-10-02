import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import dayjs from "@calcom/dayjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcSessionUser } from "../../../../types";
import { weeklyHoursHandler } from "./weeklyHours.handler";

vi.mock("@calcom/app-store/delegationCredential", () => ({
  enrichUsersWithDelegationCredentials: vi.fn().mockImplementation(({ users }) => Promise.resolve(users)),
}));

vi.mock("@calcom/features/di/containers/GetUserAvailability", () => ({
  getUserAvailabilityService: vi.fn(() => ({
    getUserAvailability: vi.fn().mockResolvedValue({
      scheduledDateRanges: [
        { start: dayjs.utc("2026-09-28T09:00:00.000Z"), end: dayjs.utc("2026-09-28T17:00:00.000Z") },
      ],
      busy: [],
      calendarFetchFailed: false,
    }),
  })),
}));

const ORG_ID = 7;
const CLIENT_ID = "cli_prod";
const PROVIDER_ID = 11;

const ctxUser = (): NonNullable<TrpcSessionUser> =>
  ({ id: 1, organizationId: ORG_ID }) as NonNullable<TrpcSessionUser>;

const input = (overrides: Record<string, unknown> = {}) => ({
  oAuthClientId: CLIENT_ID,
  userIds: [PROVIDER_ID],
  weekStart: dayjs.utc().startOf("day").format("YYYY-MM-DD"),
  loggedInUsersTz: "UTC",
  ...overrides,
});

describe("weeklyHoursHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.platformOAuthClient.findUnique.mockResolvedValue({ organizationId: ORG_ID });
    prismaMock.membership.findUnique.mockResolvedValue({ role: "OWNER" });
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: PROVIDER_ID,
        email: "provider@example.com",
        timeZone: "UTC",
        defaultScheduleId: 5,
        credentials: [],
        selectedCalendars: [],
        schedules: [],
        availability: [],
        travelSchedules: [],
      },
    ]);
    prismaMock.booking.findMany.mockResolvedValue([]);
    prismaMock.scheduleVersion.findFirst.mockResolvedValue(null);
  });

  it("scopes the provider lookup to the OAuth client as well as the ids", async () => {
    await weeklyHoursHandler({ ctx: { user: ctxUser() }, input: input() });

    expect(prismaMock.user.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [PROVIDER_ID] },
      platformOAuthClients: { some: { id: CLIENT_ID } },
    });
  });

  it("computes the current week live", async () => {
    const result = await weeklyHoursHandler({ ctx: { user: ctxUser() }, input: input() });

    expect(result[String(PROVIDER_ID)].source).toBe("live");
    expect(prismaMock.scheduleVersion.findFirst).not.toHaveBeenCalled();
  });

  it("computes a week still to come live rather than from history", async () => {
    const nextWeek = dayjs.utc().add(14, "day").format("YYYY-MM-DD");

    const result = await weeklyHoursHandler({
      ctx: { user: ctxUser() },
      input: input({ weekStart: nextWeek }),
    });

    expect(result[String(PROVIDER_ID)].source).toBe("live");
  });

  it("reads a week that has already ended from schedule history", async () => {
    const lastWeek = dayjs.utc().subtract(14, "day").format("YYYY-MM-DD");

    const result = await weeklyHoursHandler({
      ctx: { user: ctxUser() },
      input: input({ weekStart: lastWeek }),
    });

    // No snapshot exists for the fixture, so the recorded path reports it as unrecorded —
    // which is itself the proof that the live path was not taken.
    expect(result[String(PROVIDER_ID)].source).toBe("unrecorded");
    expect(prismaMock.scheduleVersion.findFirst).toHaveBeenCalled();
  });

  it("refuses a caller who does not administer the client's organization", async () => {
    prismaMock.membership.findUnique.mockResolvedValue(null);

    await expect(weeklyHoursHandler({ ctx: { user: ctxUser() }, input: input() })).rejects.toThrow(
      /Only organization owners and admins/
    );
  });
});
