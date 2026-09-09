import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import { describe, expect, it } from "vitest";
import { PlatformOAuthClientRepository } from "./platform-oauth-client.repository";

describe("PlatformOAuthClientRepository.findByOrganizationId", () => {
  it("selects only id and name, never the secret", async () => {
    prismaMock.platformOAuthClient.findMany.mockResolvedValue([]);

    await new PlatformOAuthClientRepository().findByOrganizationId(7);

    const args = prismaMock.platformOAuthClient.findMany.mock.calls[0][0];
    expect(args.select).toEqual({ id: true, name: true });
    expect(args.select).not.toHaveProperty("secret");
  });

  it("scopes to the organization and orders by creation time", async () => {
    prismaMock.platformOAuthClient.findMany.mockResolvedValue([]);

    await new PlatformOAuthClientRepository().findByOrganizationId(7);

    const args = prismaMock.platformOAuthClient.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ organizationId: 7 });
    expect(args.orderBy).toEqual({ createdAt: "asc" });
  });

  it("returns the rows prisma gives it", async () => {
    prismaMock.platformOAuthClient.findMany.mockResolvedValue([
      { id: "cli_dev", name: "Development" },
      { id: "cli_prod", name: "Production" },
    ]);

    const result = await new PlatformOAuthClientRepository().findByOrganizationId(7);

    expect(result).toEqual([
      { id: "cli_dev", name: "Development" },
      { id: "cli_prod", name: "Production" },
    ]);
  });
});
