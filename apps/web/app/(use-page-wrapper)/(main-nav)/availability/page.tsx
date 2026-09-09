import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { PlatformOAuthClientRepository } from "@calcom/features/platform-oauth-client/platform-oauth-client.repository";
import { getScheduleListItemData } from "@calcom/lib/schedules/transformers/getScheduleListItemData";
import { MembershipRole } from "@calcom/prisma/enums";
import { availabilityRouter } from "@calcom/trpc/server/routers/viewer/availability/_router";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { createRouterCaller, getTRPCContext } from "app/_trpc/context";
import type { PageProps, ReadonlyHeaders, ReadonlyRequestCookies } from "app/_types";
import { _generateMetadata, getTranslate } from "app/_utils";
import { unstable_cache } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AvailabilityCTA, AvailabilityList } from "~/availability/availability-view";
import { AvailabilitySliderTable } from "~/timezone-buddy/components/AvailabilitySliderTable";
import { ShellMainAppDir } from "../ShellMainAppDir";

export const generateMetadata = async () => {
  return await _generateMetadata(
    (t) => t("availability"),
    (t) => t("configure_availability"),
    undefined,
    undefined,
    "/availability"
  );
};

const getCachedAvailabilities = unstable_cache(
  async (headers: ReadonlyHeaders, cookies: ReadonlyRequestCookies) => {
    const availabilityCaller = await createRouterCaller(
      availabilityRouter,
      await getTRPCContext(headers, cookies)
    );
    return await availabilityCaller.list();
  },
  ["viewer.availability.list"],
  { revalidate: 3600 } // Cache for 1 hour
);

const Page = async ({ searchParams: _searchParams }: PageProps) => {
  const searchParams = await _searchParams;
  const t = await getTranslate();
  const _headers = await headers();
  const _cookies = await cookies();
  const session = await getServerSession({ req: buildLegacyRequest(_headers, _cookies) });
  if (!session?.user?.id) {
    return redirect("/auth/login");
  }

  // Resolved from membership, not from the session. `session.user.org` is always null for
  // platform organizations, and `session.user.profile` falls back to a personal profile with
  // no organization whenever the JWT predates the user joining one — which is the normal state
  // after `setup-platform-org.ts` promotes an existing user.
  const adminOrganizationIds = await new MembershipRepository().findTeamIdsByUserIdAndRoles({
    userId: session.user.id,
    roles: [MembershipRole.OWNER, MembershipRole.ADMIN],
  });

  const oAuthClients = adminOrganizationIds.length
    ? await new PlatformOAuthClientRepository().findByOrganizationIds(adminOrganizationIds)
    : [];

  const requestedClientId = typeof searchParams?.client === "string" ? searchParams.client : undefined;
  // An unknown id degrades to the schedule list rather than erroring, so a bookmark kept
  // after a client is deleted still opens the page.
  const activeClient = oAuthClients.find((client) => client.id === requestedClientId);

  if (activeClient) {
    return (
      <ShellMainAppDir
        heading={t("availability")}
        subtitle={t("configure_availability")}
        CTA={<AvailabilityCTA oAuthClients={oAuthClients} />}>
        <AvailabilitySliderTable oAuthClientId={activeClient.id} />
      </ShellMainAppDir>
    );
  }

  const cachedAvailabilities = await getCachedAvailabilities(_headers, _cookies);

  // Transform the data to ensure startTime, endTime, and date are Date objects
  // This is because the data is cached and as a result the data is converted to a string
  const availabilities = {
    ...cachedAvailabilities,
    schedules: cachedAvailabilities.schedules.map((schedule) => getScheduleListItemData(schedule)),
  };

  return (
    <ShellMainAppDir
      heading={t("availability")}
      subtitle={t("configure_availability")}
      CTA={<AvailabilityCTA oAuthClients={oAuthClients} />}>
      <AvailabilityList availabilities={availabilities ?? { schedules: [] }} />
    </ShellMainAppDir>
  );
};

export default Page;
