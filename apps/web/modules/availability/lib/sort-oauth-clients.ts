type OAuthClientListItem = {
  id: string;
  name: string;
};

/** Query-param value that means "show my own schedules" rather than a client's grid. */
export const MY_AVAILABILITY = "mine";

const PRODUCTION = "production";

// Environment precedence, most-production-first. Names are typed by hand in the platform
// dashboard, so they are matched case-insensitively and trimmed.
const ENVIRONMENT_ORDER = [PRODUCTION, "staging", "development"];

const normalize = (name: string) => name.trim().toLowerCase();

const environmentRank = (name: string) => {
  const rank = ENVIRONMENT_ORDER.indexOf(normalize(name));
  return rank === -1 ? ENVIRONMENT_ORDER.length : rank;
};

/**
 * Orders clients by environment precedence. Unrecognised names sort last and keep their
 * incoming order, which is creation order because the repository sorts by `createdAt` —
 * so no secondary comparator is needed as long as `Array.prototype.sort` stays stable.
 */
export function sortOAuthClientsByEnvironment<T extends OAuthClientListItem>(clients: T[]): T[] {
  return [...clients].sort((a, b) => environmentRank(a.name) - environmentRank(b.name));
}

/**
 * Picks the client whose availability the page should show, or `undefined` to show the
 * viewer's own schedules. Anything that is not the sentinel and does not match a client —
 * including a bookmark for a since-deleted client — falls back to production.
 */
export function resolveActiveOAuthClient<T extends OAuthClientListItem>({
  clients,
  requestedClientId,
}: {
  clients: T[];
  requestedClientId: string | undefined;
}): T | undefined {
  if (requestedClientId === MY_AVAILABILITY) return undefined;

  const requested = clients.find((client) => client.id === requestedClientId);
  if (requested) return requested;

  return clients.find((client) => normalize(client.name) === PRODUCTION);
}
