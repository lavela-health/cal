import process from "node:process";
import prisma from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { uuid } from "short-uuid";
import { createUserAndEventType } from "./seed-utils";

const PLATFORM_ORG_NAME = "Platform Org";
const PLATFORM_ORG_SLUG = "platform-org";
const PLATFORM_USER = {
  email: "platform@example.com",
  password: "platform",
  username: "platform",
  name: "Platform Owner",
};

async function createPlatformOrganization() {
  // Team.slug is unique per parentId rather than on its own, so there is no compound
  // unique input to upsert against for a top-level organization.
  const existingOrganization = await prisma.team.findFirst({
    where: { slug: PLATFORM_ORG_SLUG, parentId: null },
    select: { id: true },
  });

  if (existingOrganization) {
    console.log(`🏢 Platform organization '${PLATFORM_ORG_SLUG}' already seeded`);
    return existingOrganization;
  }

  const organization = await prisma.team.create({
    data: {
      name: PLATFORM_ORG_NAME,
      slug: PLATFORM_ORG_SLUG,
      isOrganization: true,
      isPlatform: true,
      organizationSettings: {
        create: {
          orgAutoAcceptEmail: "example.com",
          isOrganizationVerified: true,
          isOrganizationConfigured: true,
          isAdminReviewed: true,
        },
      },
    },
    select: { id: true },
  });

  console.log(`🏢 Created platform organization '${PLATFORM_ORG_SLUG}'`);
  return organization;
}

async function main() {
  const user = await createUserAndEventType({
    user: {
      ...PLATFORM_USER,
      completedOnboarding: true,
    },
  });

  const organization = await createPlatformOrganization();

  await prisma.membership.upsert({
    where: { userId_teamId: { userId: user.id, teamId: organization.id } },
    update: { role: MembershipRole.OWNER, accepted: true },
    create: {
      userId: user.id,
      teamId: organization.id,
      role: MembershipRole.OWNER,
      accepted: true,
    },
  });

  // platformMe resolves the org through Profile rows, not through Membership,
  // so without this the dashboard still reports the user as non-platform.
  await prisma.profile.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: organization.id } },
    update: { username: PLATFORM_USER.username },
    create: {
      // Bare uuidv4, matching ProfileRepository.generateProfileUid(). The "usr-" prefix is the
      // personal-profile namespace in getLookupTarget() and must not be used for org profiles.
      uid: uuid(),
      userId: user.id,
      organizationId: organization.id,
      username: PLATFORM_USER.username,
    },
  });

  console.log(
    `\n✅ Platform owner seeded — log in as '${PLATFORM_USER.username}' / '${PLATFORM_USER.password}' and open ${
      process.env.NEXT_PUBLIC_WEBAPP_URL ?? "http://localhost:3002"
    }/settings/platform`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
