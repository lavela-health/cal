import prisma from "@calcom/prisma";
import { captureException } from "@sentry/nextjs";
import type {
  IPlatformOAuthClientRepository,
  PlatformOAuthClientListItem,
} from "./platform-oauth-client.repository.interface";

export class PlatformOAuthClientRepository implements IPlatformOAuthClientRepository {
  async getByUserId(userId: number) {
    try {
      return prisma.platformOAuthClient.findFirst({
        where: {
          users: {
            some: {
              id: userId,
            },
          },
        },
      });
    } catch (err) {
      captureException(err);
      throw err;
    }
  }

  async findByOrganizationId(organizationId: number): Promise<PlatformOAuthClientListItem[]> {
    try {
      return prisma.platformOAuthClient.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      });
    } catch (err) {
      captureException(err);
      throw err;
    }
  }
}
