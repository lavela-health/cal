import { MembershipRole } from "@calcom/prisma/enums";
import { describe, expect, it, vi } from "vitest";
import { PermissionCheckService } from "./PermissionCheckService";

const buildRepository = (teamIds: number[] = []) => ({
  findTeamIdsByUserIdAndRoles: vi.fn().mockResolvedValue(teamIds),
});

describe("PermissionCheckService.getTeamIdsWithPermission", () => {
  it("returns the teams the user has an eligible role in", async () => {
    const repository = buildRepository([18, 42]);
    const service = new PermissionCheckService(repository as never);

    const teamIds = await service.getTeamIdsWithPermission({
      userId: 1,
      permission: "booking.read",
      fallbackRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
    });

    expect(teamIds).toEqual([18, 42]);
  });

  it("forwards the roles and organization scope to the repository", async () => {
    const repository = buildRepository();
    const service = new PermissionCheckService(repository as never);

    await service.getTeamIdsWithPermission({
      userId: 7,
      permission: "booking.read",
      fallbackRoles: [MembershipRole.OWNER],
      orgId: 18,
    });

    expect(repository.findTeamIdsByUserIdAndRoles).toHaveBeenCalledWith({
      userId: 7,
      roles: [MembershipRole.OWNER],
      orgId: 18,
    });
  });

  it("returns no teams when no roles are eligible", async () => {
    const repository = buildRepository([18]);
    const service = new PermissionCheckService(repository as never);

    const teamIds = await service.getTeamIdsWithPermission({
      userId: 1,
      permission: "booking.read",
      fallbackRoles: [],
    });

    // An empty result silently hides other members' bookings rather than erroring,
    // so it must only happen when the caller genuinely has no eligible role.
    expect(teamIds).toEqual([]);
    expect(repository.findTeamIdsByUserIdAndRoles).not.toHaveBeenCalled();
  });
});
