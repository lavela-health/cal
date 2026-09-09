import type { PlatformOAuthClient } from "@calcom/prisma/client";

export type PlatformOAuthClientListItem = Pick<PlatformOAuthClient, "id" | "name">;

export interface IPlatformOAuthClientRepository {
  getByUserId(userId: number): Promise<PlatformOAuthClient | null>;
  findByOrganizationId(organizationId: number): Promise<PlatformOAuthClientListItem[]>;
}
