import { prisma } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { TRPCError } from "@trpc/server";

/**
 * Resolves the organization from the OAuth client rather than from the session, and returns it so
 * the caller can scope the listing with it.
 *
 * The session cannot be trusted here: `session.upId` is baked into the JWT at sign-in, so a token
 * minted before the user joined the organization resolves to their personal profile and reports no
 * organization at all. `setup-platform-org.ts` promotes an existing user, so this is the normal
 * state right after the org is created, not an edge case.
 *
 * Deriving the organization from the client keeps authorization honest — membership is still
 * checked against the organization that owns the client, so a caller can only read clients
 * belonging to an organization they administer.
 */
export async function resolveOAuthClientOrganization({
  userId,
  oAuthClientId,
}: {
  userId: number;
  oAuthClientId: string;
}): Promise<number> {
  const client = await prisma.platformOAuthClient.findUnique({
    where: { id: oAuthClientId },
    select: { organizationId: true },
  });

  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: `OAuth client ${oAuthClientId} not found.` });
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_teamId: { userId, teamId: client.organizationId } },
    select: { role: true },
  });

  if (!membership || (membership.role !== MembershipRole.OWNER && membership.role !== MembershipRole.ADMIN)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only organization owners and admins can filter availability by OAuth client.",
    });
  }

  return client.organizationId;
}
