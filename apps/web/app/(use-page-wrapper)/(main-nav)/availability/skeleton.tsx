"use client";

import SkeletonLoader from "@calcom/features/availability/components/SkeletonLoader";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { ShellMainAppDir } from "app/(use-page-wrapper)/(main-nav)/ShellMainAppDir";
import { AvailabilityCTA } from "~/availability/availability-view";
import { MY_AVAILABILITY } from "~/availability/lib/sort-oauth-clients";

export default function AvailabilityLoader() {
  const { t } = useLocale();

  return (
    <ShellMainAppDir
      heading={t("availability")}
      subtitle={t("configure_availability")}
      CTA={<AvailabilityCTA oAuthClients={[]} activeValue={MY_AVAILABILITY} />}>
      <SkeletonLoader />
    </ShellMainAppDir>
  );
}
