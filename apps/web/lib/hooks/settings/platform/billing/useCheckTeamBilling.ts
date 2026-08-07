import { useQuery } from "@tanstack/react-query";

export const useCheckTeamBilling = (teamId?: number | null, isPlatformTeam?: boolean | null) => {
  const QUERY_KEY = "check-team-billing";
  const isTeamBilledAlready = useQuery({
    queryKey: [QUERY_KEY, teamId],
    // This fork removed the platform billing module from API v2, so /api/v2/billing/:teamId/check
    // no longer exists. Self-hosted platform teams are always treated as subscribed; without this
    // the dashboard would sit behind a Stripe paywall whose endpoints are gone.
    queryFn: async (): Promise<{ valid: boolean; plan: string }> => {
      return { valid: true, plan: "ENTERPRISE" };
    },
    enabled: !!teamId && !!isPlatformTeam,
    staleTime: 5000,
  });

  return isTeamBilledAlready;
};
