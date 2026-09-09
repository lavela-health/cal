import { describe, expect, it } from "vitest";
import {
  MY_AVAILABILITY,
  resolveActiveOAuthClient,
  sortOAuthClientsByEnvironment,
} from "./sort-oauth-clients";

const client = (id: string, name: string) => ({ id, name });

describe("sortOAuthClientsByEnvironment", () => {
  it("orders production, then staging, then development", () => {
    const sorted = sortOAuthClientsByEnvironment([
      client("dev", "Development"),
      client("prod", "Production"),
      client("stg", "Staging"),
    ]);

    expect(sorted.map((c) => c.name)).toEqual(["Production", "Staging", "Development"]);
  });

  it("matches names regardless of case or surrounding whitespace", () => {
    const sorted = sortOAuthClientsByEnvironment([
      client("dev", "  development  "),
      client("prod", "PRODUCTION"),
      client("stg", "staging"),
    ]);

    expect(sorted.map((c) => c.id)).toEqual(["prod", "stg", "dev"]);
  });

  it("places unrecognised names after the known environments", () => {
    const sorted = sortOAuthClientsByEnvironment([
      client("qa", "QA"),
      client("prod", "Production"),
      client("demo", "Demo"),
    ]);

    expect(sorted.map((c) => c.id)).toEqual(["prod", "qa", "demo"]);
  });

  it("preserves input order among unrecognised names", () => {
    // The repository returns clients by createdAt, so a stable sort keeps unranked
    // clients in creation order without a secondary comparator.
    const sorted = sortOAuthClientsByEnvironment([
      client("zeta", "Zeta"),
      client("alpha", "Alpha"),
      client("prod", "Production"),
    ]);

    expect(sorted.map((c) => c.id)).toEqual(["prod", "zeta", "alpha"]);
  });

  it("does not mutate the array it is given", () => {
    const clients = [client("dev", "Development"), client("prod", "Production")];

    sortOAuthClientsByEnvironment(clients);

    expect(clients.map((c) => c.id)).toEqual(["dev", "prod"]);
  });

  it("returns an empty array unchanged", () => {
    expect(sortOAuthClientsByEnvironment([])).toEqual([]);
  });
});

describe("resolveActiveOAuthClient", () => {
  const clients = [client("prod", "Production"), client("stg", "Staging")];

  it("defaults to production when no client is requested", () => {
    const active = resolveActiveOAuthClient({ clients, requestedClientId: undefined });

    expect(active?.id).toBe("prod");
  });

  it("returns the requested client when the id is known", () => {
    const active = resolveActiveOAuthClient({ clients, requestedClientId: "stg" });

    expect(active?.id).toBe("stg");
  });

  it("returns nothing for the my-availability sentinel", () => {
    const active = resolveActiveOAuthClient({ clients, requestedClientId: MY_AVAILABILITY });

    expect(active).toBeUndefined();
  });

  it("falls back to production for an unknown id", () => {
    const active = resolveActiveOAuthClient({ clients, requestedClientId: "deleted-client" });

    expect(active?.id).toBe("prod");
  });

  it("returns nothing when there is no production client to fall back to", () => {
    const withoutProduction = [client("stg", "Staging"), client("dev", "Development")];

    const active = resolveActiveOAuthClient({
      clients: withoutProduction,
      requestedClientId: undefined,
    });

    expect(active).toBeUndefined();
  });

  it("still resolves a known id when no production client exists", () => {
    const withoutProduction = [client("stg", "Staging"), client("dev", "Development")];

    const active = resolveActiveOAuthClient({
      clients: withoutProduction,
      requestedClientId: "dev",
    });

    expect(active?.id).toBe("dev");
  });

  it("finds the production client regardless of case", () => {
    const active = resolveActiveOAuthClient({
      clients: [client("stg", "Staging"), client("prod", "production")],
      requestedClientId: undefined,
    });

    expect(active?.id).toBe("prod");
  });

  it("returns nothing when there are no clients at all", () => {
    expect(resolveActiveOAuthClient({ clients: [], requestedClientId: undefined })).toBeUndefined();
  });
});
