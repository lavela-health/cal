import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcSessionUser } from "../../../../types";
import { listTeamAvailabilityHandler } from "./listTeamAvailability.handler";

vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: vi.fn().mockImplementation(function () {
    return {
      enrichUsersWithTheirProfileExcludingOrgMetadata: vi.fn().mockResolvedValue([]),
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
    prismaMock.platformOAuthClient.findFirst.mockResolvedValue({ id: CLIENT_ID });
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

  it("rejects a client that belongs to a different organization", async () => {
    prismaMock.platformOAuthClient.findFirst.mockResolvedValue(null);

    await expect(
      listTeamAvailabilityHandler({
        ctx: { user: ctxUser() },
        input: input({ oAuthClientId: CLIENT_ID }),
      })
    ).rejects.toThrow(/does not belong/i);
  });

  it("scopes the client lookup to the caller's organization", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ oAuthClientId: CLIENT_ID }),
    });

    expect(prismaMock.platformOAuthClient.findFirst).toHaveBeenCalledWith({
      where: { id: CLIENT_ID, organizationId: ORG_ID },
      select: { id: true },
    });
  });

  it("runs no authorization queries when no client is given", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input(),
    });

    expect(prismaMock.platformOAuthClient.findFirst).not.toHaveBeenCalled();
  });
});
