import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { CreationSource, MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNewUsersConnectToOrgIfExists } from "./createNewUsersConnectToOrgIfExists";

const ORG_ID = 18;
const EMAIL = "amy.farrah.fowler+clientid@test.com";

const createManagedUser = (email: string = EMAIL) =>
  createNewUsersConnectToOrgIfExists({
    invitations: [{ usernameOrEmail: email, role: MembershipRole.MEMBER }],
    creationSource: CreationSource.API_V2,
    teamId: ORG_ID,
    isOrg: true,
    parentId: null,
    autoAcceptEmailDomain: "never-auto-accept-email-domain-for-managed-users",
    orgConnectInfoByUsernameOrEmail: { [email]: { orgId: ORG_ID, autoAccept: true } },
    isPlatformManaged: true,
    timeFormat: 12,
    weekStart: "Sunday",
    timeZone: "Europe/London",
    language: "en",
  });

describe("createNewUsersConnectToOrgIfExists", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    await prismock.reset();
  });

  it("creates a managed user connected to the organization", async () => {
    const [user] = await createManagedUser();

    expect(user.email).toBe(EMAIL);
    expect(user.isPlatformManaged).toBe(true);
    expect(user.organizationId).toBe(ORG_ID);
    expect(user.verified).toBe(true);
    expect(user.timeZone).toBe("Europe/London");
  });

  it("creates the Profile the platform dashboard resolves the organization through", async () => {
    const [user] = await createManagedUser();

    const profiles = await prismock.profile.findMany({ where: { userId: user.id } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].organizationId).toBe(ORG_ID);
    // "usr-" is the personal-profile namespace in getLookupTarget, so org profiles must not use it.
    expect(profiles[0].uid.startsWith("usr-")).toBe(false);
  });

  it("accepts the membership so the user counts as an organization member", async () => {
    const [user] = await createManagedUser();

    const memberships = await prismock.membership.findMany({ where: { userId: user.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].teamId).toBe(ORG_ID);
    expect(memberships[0].accepted).toBe(true);
  });

  it("appends the TLD to managed usernames so generated emails cannot collide", async () => {
    const [user] = await createManagedUser();

    expect(user.username).toBe("amy.farrah.fowler-clientid-test-com");
  });

  it("leaves schedule creation to the caller for managed users", async () => {
    const [user] = await createManagedUser();

    // The API v2 service creates the schedule itself so it can apply the requested timeZone.
    const schedules = await prismock.schedule.findMany({ where: { userId: user.id } });
    expect(schedules).toHaveLength(0);
  });

  it("rejects invitations that are not email addresses", async () => {
    await expect(
      createNewUsersConnectToOrgIfExists({
        invitations: [{ usernameOrEmail: "not-an-email", role: MembershipRole.MEMBER }],
        teamId: ORG_ID,
        isOrg: true,
        parentId: null,
        autoAcceptEmailDomain: null,
        orgConnectInfoByUsernameOrEmail: { "not-an-email": { orgId: ORG_ID, autoAccept: true } },
      })
    ).rejects.toThrow(/must be an email address/);
  });
});
