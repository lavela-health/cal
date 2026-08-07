import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { DEFAULT_SCHEDULE, getAvailabilityFromSchedule } from "@calcom/lib/availability";
import { ErrorWithCode } from "@calcom/lib/errors";
import { slugify } from "@calcom/lib/slugify";
import prisma from "@calcom/prisma";
import type { CreationSource, MembershipRole } from "@calcom/prisma/enums";

type Invitation = {
  usernameOrEmail: string;
  role: MembershipRole | string;
};

type CreateNewUsersArgs = {
  invitations: Invitation[];
  isOrg: boolean;
  teamId: number;
  parentId?: number | null;
  autoAcceptEmailDomain: string | null;
  orgConnectInfoByUsernameOrEmail: Record<string, { orgId: number | null; autoAccept: boolean }>;
  isPlatformManaged?: boolean;
  timeFormat?: number;
  weekStart?: string;
  timeZone?: string;
  language?: string;
  creationSource?: CreationSource;
};

/**
 * Reinstates the org-invitation path that the Cal.diy refactor replaced with a throwing stub,
 * which made every managed-user creation return a bare 500 from API v2.
 *
 * Scoped to what the single caller (API v2 managed users) needs: create the user, connect it to
 * the organization via Profile + Membership. Upstream also emitted seat-tracking for billing;
 * that service does not exist in this fork, so it is intentionally omitted.
 */
export async function createNewUsersConnectToOrgIfExists({
  invitations,
  isOrg,
  teamId,
  parentId,
  autoAcceptEmailDomain,
  orgConnectInfoByUsernameOrEmail,
  isPlatformManaged,
  timeFormat,
  weekStart,
  timeZone,
  creationSource,
}: CreateNewUsersArgs) {
  for (const invitation of invitations) {
    if (!invitation.usernameOrEmail.includes("@")) {
      throw ErrorWithCode.Factory.BadRequest(
        `Invited user must be an email address, received "${invitation.usernameOrEmail}"`
      );
    }
  }

  return prisma.$transaction(
    async (tx) => {
      const createdUsers = [];

      for (const invitation of invitations) {
        const connectInfo = orgConnectInfoByUsernameOrEmail[invitation.usernameOrEmail];
        const orgId = connectInfo?.orgId ?? null;
        const autoAccept = connectInfo?.autoAccept ?? false;

        const [emailUser, emailDomain] = invitation.usernameOrEmail.split("@");
        const [domainName, TLD] = emailDomain.split(".");

        // Org members cannot pick a username during signup, so it is derived here. Managed users
        // additionally get the TLD appended because their generated emails collide otherwise.
        const orgMemberUsername =
          emailDomain === autoAcceptEmailDomain
            ? slugify(emailUser)
            : slugify(`${emailUser}-${domainName}${isPlatformManaged ? `-${TLD}` : ""}`);

        const isBecomingAnOrgMember = Boolean(parentId) || isOrg;
        const defaultAvailability = getAvailabilityFromSchedule(DEFAULT_SCHEDULE);

        const createdUser = await tx.user.create({
          data: {
            username: isBecomingAnOrgMember ? orgMemberUsername : null,
            email: invitation.usernameOrEmail,
            verified: true,
            invitedTo: teamId,
            isPlatformManaged: !!isPlatformManaged,
            timeFormat,
            weekStart,
            timeZone,
            creationSource,
            organizationId: orgId,
            ...(orgId
              ? {
                  profiles: {
                    createMany: {
                      data: [
                        {
                          uid: ProfileRepository.generateProfileUid(),
                          username: orgMemberUsername,
                          organizationId: orgId,
                        },
                      ],
                    },
                  },
                }
              : null),
            teams: {
              create: {
                teamId,
                role: invitation.role as MembershipRole,
                accepted: autoAccept,
              },
            },
            // Managed users get their schedule from the caller, which applies the requested timeZone.
            ...(!isPlatformManaged
              ? {
                  schedules: {
                    create: {
                      name: "Working Hours",
                      availability: {
                        createMany: {
                          data: defaultAvailability.map((schedule) => ({
                            days: schedule.days,
                            startTime: schedule.startTime,
                            endTime: schedule.endTime,
                          })),
                        },
                      },
                    },
                  },
                }
              : {}),
          },
        });

        if (parentId) {
          await tx.membership.create({
            data: {
              createdAt: new Date(),
              teamId: parentId,
              userId: createdUser.id,
              role: "MEMBER",
              accepted: autoAccept,
            },
          });
        }

        createdUsers.push(createdUser);
      }

      return createdUsers;
    },
    { timeout: 10000 }
  );
}
