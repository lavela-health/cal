/**
 * Grants an EXISTING user Platform access by creating a platform organization and
 * wiring the user into it.
 *
 * Unlike scripts/seed-platform.ts, this creates no users and sets no passwords, so it
 * is safe to run against production. It is idempotent: re-running reconciles rather
 * than duplicating.
 *
 * Usage:
 *   PLATFORM_OWNER_EMAIL=admin@lavelahealth.com \
 *   DATABASE_URL=<render external connection string> \
 *   yarn workspace @calcom/prisma setup-platform
 */
import { randomUUID } from "node:crypto";
import process from "node:process";
import prisma from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";

const ownerEmail = process.env.PLATFORM_OWNER_EMAIL;
const orgName = process.env.PLATFORM_ORG_NAME ?? "Lavela Health";
const orgSlug = process.env.PLATFORM_ORG_SLUG ?? "lavela-health";

async function main() {
  if (!ownerEmail) {
    throw new Error("PLATFORM_OWNER_EMAIL is required — the email of the existing user to promote");
  }

  const user = await prisma.user.findUnique({
    where: { email: ownerEmail },
    select: { id: true, email: true, username: true },
  });

  if (!user) {
    throw new Error(
      `No user with email '${ownerEmail}'. Create the admin through the app first, then re-run.`
    );
  }

  // Team.slug is unique per parentId rather than on its own, so there is no compound
  // unique input to upsert against for a top-level organization.
  let organization = await prisma.team.findFirst({
    where: { slug: orgSlug, parentId: null },
    select: { id: true, isPlatform: true },
  });

  if (organization && !organization.isPlatform) {
    throw new Error(
      `Team '${orgSlug}' exists but is not a platform organization. Refusing to mutate it — ` +
        `pick a different PLATFORM_ORG_SLUG.`
    );
  }

  if (!organization) {
    organization = await prisma.team.create({
      data: {
        name: orgName,
        slug: orgSlug,
        isOrganization: true,
        isPlatform: true,
        organizationSettings: {
          create: {
            orgAutoAcceptEmail: ownerEmail.split("@")[1],
            isOrganizationVerified: true,
            isOrganizationConfigured: true,
            isAdminReviewed: true,
          },
        },
      },
      select: { id: true, isPlatform: true },
    });
    console.log(`🏢 Created platform organization '${orgSlug}' (id ${organization.id})`);
  } else {
    console.log(`🏢 Platform organization '${orgSlug}' already exists (id ${organization.id})`);
  }

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
  console.log(`👤 ${user.email} is OWNER of '${orgSlug}'`);

  // Required, and easy to miss: platformMe resolves the organization through Profile
  // rows, not Membership. Without this the dashboard still reports the user as
  // non-platform even though the membership exists.
  await prisma.profile.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: organization.id } },
    update: {},
    create: {
      // Bare uuid, matching ProfileRepository.generateProfileUid(). The "usr-" prefix is
      // the personal-profile namespace in getLookupTarget() and must not be used here.
      uid: randomUUID(),
      userId: user.id,
      organizationId: organization.id,
      username: user.username ?? ownerEmail.split("@")[0],
    },
  });
  console.log(`🔗 Profile row links ${user.email} to '${orgSlug}'`);

  const baseUrl = process.env.NEXT_PUBLIC_WEBAPP_URL ?? "https://cal.lavelahealth.com";
  console.log(`\n✅ Done. Log out and back in as ${user.email}, then open ${baseUrl}/settings/platform`);
}

main()
  .catch((e) => {
    console.error(`\n❌ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
