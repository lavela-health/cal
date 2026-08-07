import type { ApiSuccessResponse } from "@calcom/platform-types";
import { useQuery } from "@tanstack/react-query";

export type ManagedUser = {
  id: number;
  email: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  timeZone: string;
  avatarUrl: string | null;
  defaultScheduleId: number | null;
};

export const useOAuthClientUsers = (clientId?: string, limit?: number, offset?: number) => {
  const query = useQuery<ApiSuccessResponse<ManagedUser[]>>({
    queryKey: ["oauth-client-users", clientId, limit, offset],
    queryFn: () => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      const queryString = params.toString();

      return fetch(`/api/v2/oauth-clients/${clientId}/users${queryString ? `?${queryString}` : ""}`, {
        method: "get",
        headers: { "Content-type": "application/json" },
      }).then((res) => res.json());
    },
    enabled: !!clientId,
  });

  return { ...query, data: query.data?.data ?? [] };
};
