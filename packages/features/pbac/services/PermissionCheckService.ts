import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import type { MembershipRole } from "@calcom/prisma/enums";

/**
 * Restores the team scoping that callers rely on to see other members' data.
 *
 * The full PBAC engine (custom roles, per-permission grants) was removed from this fork, and the
 * inline stubs left behind returned an empty team list — which silently hid organization members'
 * bookings from org admins and owners. This resolves permissions the way upstream does when PBAC
 * is not enabled for a team: by falling back to membership roles.
 */
export class PermissionCheckService {
  constructor(private readonly membershipRepository = new MembershipRepository()) {}

  async getTeamIdsWithPermission({
    userId,
    fallbackRoles,
    orgId,
  }: {
    userId: number;
    permission?: string;
    fallbackRoles: MembershipRole[];
    orgId?: number;
  }): Promise<number[]> {
    if (!fallbackRoles.length) {
      return [];
    }

    return this.membershipRepository.findTeamIdsByUserIdAndRoles({
      userId,
      roles: fallbackRoles,
      orgId,
    });
  }
}
