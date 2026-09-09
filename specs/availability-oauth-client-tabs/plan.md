# Per-OAuth-client availability tabs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tabs to `/availability` that list managed users' availability grouped by the platform OAuth client that provisioned them, so Lavela staff can inspect Development, Staging and Production separately.

**Architecture:** Extend the existing, currently-uncalled `viewer.availability.listTeam` tRPC procedure with an optional `oAuthClientId` filter (enforced server-side for `OWNER`/`ADMIN` only), restore the `timezone-buddy` slider grid deleted in `ab21c7f805`, and drive a `ToggleGroup` from a new `PlatformOAuthClientRepository.findByOrganizationId`.

**Tech Stack:** TypeScript (strict), Next.js App Router, tRPC, Prisma, zustand, TanStack Table, vitest + `vitest-mock-extended`, Biome.

**Spec:** `specs/availability-oauth-client-tabs/design.md`

## Global Constraints

- **One PR**, deliberately over `CLAUDE.md`'s 500-line / 10-file guidelines (~930 lines, 14 code files). This is an explicit decision by the repo owner, recorded in spec §6. Do not "fix" it by splitting.
- **Never select `PlatformOAuthClient.secret`** in any query added here.
- Use `select`, never `include`, in Prisma queries.
- Use `import type { X }` for type-only imports.
- Import from source paths, never barrel files (`@calcom/ui/components/button`, not `@calcom/ui`).
- `TRPCError` is correct inside `packages/trpc` handlers; `ErrorWithCode` everywhere else.
- Run tests with `TZ=UTC`.
- `agents/lavela-health-integration.md` must be updated in this same PR (Task 7).
- Do **not** refactor `listTeamAvailability.handler.ts` off direct `prisma` access. It violates the repository rule, and spec §7 puts it out of scope.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/features/platform-oauth-client/platform-oauth-client.repository.interface.ts` | Declare `findByOrganizationId` + its narrowed return type | 1 |
| `packages/features/platform-oauth-client/platform-oauth-client.repository.ts` | Implement it | 1 |
| `packages/features/platform-oauth-client/platform-oauth-client.repository.test.ts` | Prove it never selects `secret` | 1 |
| `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.schema.ts` | Accept `oAuthClientId` | 2 |
| `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.ts` | Filter both queries; authorize the filter | 2, 3 |
| `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts` | Filter + authorization tests | 2, 3 |
| `apps/web/modules/timezone-buddy/{store.ts,constants.ts}` | zustand store + `DAY_CELL_WIDTH` | 4 |
| `apps/web/modules/timezone-buddy/components/{CellHighlightContainer,HoverOverview,TimeDial}.tsx` | Grid presentation | 4 |
| `apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx` | The read-only per-client table | 5 |
| `apps/web/modules/availability/availability-view.tsx` | The tab strip in `AvailabilityCTA` | 6 |
| `apps/web/app/(use-page-wrapper)/(main-nav)/availability/page.tsx` | Gate, fetch clients, branch on `?client` | 6 |
| `packages/i18n/locales/en/common.json` | Two empty-state strings | 5 |
| `agents/lavela-health-integration.md` | Record the new admin surface + its dependency | 7 |

---

## Task 1: `PlatformOAuthClientRepository.findByOrganizationId`

**Files:**
- Modify: `packages/features/platform-oauth-client/platform-oauth-client.repository.interface.ts`
- Modify: `packages/features/platform-oauth-client/platform-oauth-client.repository.ts`
- Test: `packages/features/platform-oauth-client/platform-oauth-client.repository.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `findByOrganizationId(organizationId: number): Promise<PlatformOAuthClientListItem[]>` where `PlatformOAuthClientListItem = Pick<PlatformOAuthClient, "id" | "name">`. Task 6 imports both the class and the type.

**Context:** The existing `getByUserId` is typed `Promise<PlatformOAuthClient | null>` — the full model, `secret` included. Do **not** reuse that return type; declare the narrowed one. Retyping `getByUserId` is out of scope.

- [ ] **Step 1: Write the failing test**

Create `packages/features/platform-oauth-client/platform-oauth-client.repository.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC yarn vitest run packages/features/platform-oauth-client/platform-oauth-client.repository.test.ts`

Expected: FAIL — `findByOrganizationId is not a function`.

- [ ] **Step 3: Add the type and interface method**

In `platform-oauth-client.repository.interface.ts`, replace the whole file with:

```ts
import type { PlatformOAuthClient } from "@calcom/prisma/client";

export type PlatformOAuthClientListItem = Pick<PlatformOAuthClient, "id" | "name">;

export interface IPlatformOAuthClientRepository {
  getByUserId(userId: number): Promise<PlatformOAuthClient | null>;
  findByOrganizationId(organizationId: number): Promise<PlatformOAuthClientListItem[]>;
}
```

- [ ] **Step 4: Implement the method**

In `platform-oauth-client.repository.ts`, change the interface import to also pull in the new type:

```ts
import type {
  IPlatformOAuthClientRepository,
  PlatformOAuthClientListItem,
} from "./platform-oauth-client.repository.interface";
```

then add the method inside the class, after `getByUserId`:

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `TZ=UTC yarn vitest run packages/features/platform-oauth-client/platform-oauth-client.repository.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/features/platform-oauth-client/
git commit -m "feat(platform): list an org's OAuth clients without exposing secrets"
```

---

## Task 2: Filter `listTeam` by OAuth client

**Files:**
- Modify: `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.schema.ts`
- Modify: `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.ts:21-70` and `:216-231`
- Test: `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `TListTeamAvailaiblityScheme` gains `oAuthClientId?: string`; module-private `buildOAuthClientFilter(oAuthClientId?: string)`, reused by Task 3. Task 5 passes `oAuthClientId` from the client.

**Context — why two queries.** For an org admin, line 189 resolves `const teamId = input.teamId || ctx.user.organizationId`, taking the `else` branch. That branch runs `prisma.membership.count` (line 216) *and* `getTeamMembers` (line 231). The count feeds `meta.totalRowCount`, which the table compares against rows fetched to decide whether to keep paginating. Filter only the rows and every tab reports the full org count, and the table pages past the end of the filtered set.

- [ ] **Step 1: Write the failing test**

Create `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`:

```ts
import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcSessionUser } from "../../../../types";
import { listTeamAvailabilityHandler } from "./listTeamAvailability.handler";

vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: vi.fn().mockImplementation(function () {
    return {
      enrichUsersWithTheirProfileExcludingOrgMetadata: vi.fn().mockResolvedValue([]),
    };
  }),
}));

const ORG_ID = 7;
const CLIENT_ID = "cli_prod";

const ctxUser = (overrides: Partial<NonNullable<TrpcSessionUser>> = {}) =>
  ({
    id: 1,
    organizationId: ORG_ID,
    ...overrides,
  }) as NonNullable<TrpcSessionUser>;

const input = (overrides: Record<string, unknown> = {}) => ({
  limit: 10,
  cursor: null,
  startDate: "2026-09-09T00:00:00.000Z",
  endDate: "2026-09-09T23:59:59.000Z",
  loggedInUsersTz: "UTC",
  ...overrides,
});

describe("listTeamAvailabilityHandler — OAuth client filter", () => {
  beforeEach(() => {
    prismaMock.membership.findUnique.mockResolvedValue({ id: 1, role: "OWNER" });
    prismaMock.membership.count.mockResolvedValue(0);
    prismaMock.membership.findMany.mockResolvedValue([]);
    prismaMock.platformOAuthClient.findFirst.mockResolvedValue({ id: CLIENT_ID });
  });

  it("applies the client filter to the member query", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ oAuthClientId: CLIENT_ID }),
    });

    const where = prismaMock.membership.findMany.mock.calls[0][0].where;
    expect(where.user).toEqual({ platformOAuthClients: { some: { id: CLIENT_ID } } });
  });

  it("applies the client filter to the count query", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ oAuthClientId: CLIENT_ID }),
    });

    const where = prismaMock.membership.count.mock.calls[0][0].where;
    expect(where.user).toEqual({ platformOAuthClients: { some: { id: CLIENT_ID } } });
  });

  it("leaves both queries unfiltered when no client is given", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input(),
    });

    expect(prismaMock.membership.findMany.mock.calls[0][0].where.user).toBeUndefined();
    expect(prismaMock.membership.count.mock.calls[0][0].where.user).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`

Expected: FAIL — the first two tests get `undefined` for `where.user`.

- [ ] **Step 3: Add the schema field**

In `listTeamAvailability.schema.ts`, add one line inside the object, after `teamId`:

```ts
  oAuthClientId: z.string().optional(),
```

- [ ] **Step 4: Add the shared filter helper**

Add to `listTeamAvailability.handler.ts`, directly above `async function getTeamMembers`:

```ts
function buildOAuthClientFilter(oAuthClientId?: string) {
  if (!oAuthClientId) return {};
  return { user: { platformOAuthClients: { some: { id: oAuthClientId } } } };
}
```

- [ ] **Step 5: Thread the filter through `getTeamMembers`**

Add `oAuthClientId` to the destructured params and the param type of `getTeamMembers` (line 21), then add the spread to its `where` (line 36):

```ts
async function getTeamMembers({
  teamId,
  organizationId,
  teamIds,
  cursor,
  limit,
  searchString,
  oAuthClientId,
}: {
  teamId?: number;
  organizationId: number | null;
  teamIds?: number[];
  cursor: number | null | undefined;
  limit: number;
  searchString?: string | null;
  oAuthClientId?: string;
}) {
  const memberships = await prisma.membership.findMany({
    where: {
      teamId: {
        in: teamId ? [teamId] : teamIds,
      },
      ...buildOAuthClientFilter(oAuthClientId),
      ...(searchString
```

Leave the rest of the function — the `select`, `cursor`, `take`, `orderBy`, `distinct`, and the `UserRepository` enrichment below it — untouched.

- [ ] **Step 6: Apply the filter to the count and pass it to `getTeamMembers`**

In the `else` branch of `listTeamAvailabilityHandler`, change the count (line 216) and the `getTeamMembers` call (line 231):

```ts
      totalTeamMembers = await prisma.membership.count({
        where: {
          teamId: teamId,
          ...buildOAuthClientFilter(input.oAuthClientId),
          ...(searchString
            ? {
                OR: [
                  { user: { username: { contains: searchString } } },
                  { user: { name: { contains: searchString } } },
                  { user: { email: { contains: searchString } } },
                ],
              }
            : {}),
        },
      });

      // I couldnt get this query to work direct on membership table
      teamMembers = await getTeamMembers({
        teamId,
        cursor,
        limit,
        organizationId: ctx.user.organizationId,
        searchString,
        oAuthClientId: input.oAuthClientId,
      });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/trpc/server/routers/viewer/availability/team/
git commit -m "feat(availability): filter team availability by platform OAuth client"
```

---

## Task 3: Authorize the OAuth client filter

**Files:**
- Modify: `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.ts`
- Test: `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`

**Interfaces:**
- Consumes: `buildOAuthClientFilter` and the `oAuthClientId` input from Task 2
- Produces: nothing new; hardens the same procedure

**Context — why this is not optional.** Task 6 hides the tab strip from non-admins, but that is presentation. Without a server check, any managed user with a web session could call `listTeam` with another environment's client id and read every provider's schedule. Two checks are needed, not one: the role check alone would still let a legitimate admin of org A read org B's clients.

This adds a second `membership.findUnique` alongside the one at line 201. That is one extra lookup on a unique key, accepted in exchange for a self-contained guard that runs before any branching.

- [ ] **Step 1: Write the failing tests**

Append these four tests inside the existing `describe` block in `listTeamAvailability.handler.test.ts`:

```ts
  it("rejects a MEMBER who passes an oAuthClientId", async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ id: 1, role: "MEMBER" });

    await expect(
      listTeamAvailabilityHandler({
        ctx: { user: ctxUser() },
        input: input({ oAuthClientId: CLIENT_ID }),
      })
    ).rejects.toThrow(/owners and admins/i);
  });

  it("rejects a client that belongs to a different organization", async () => {
    prismaMock.platformOAuthClient.findFirst.mockResolvedValue(null);

    await expect(
      listTeamAvailabilityHandler({
        ctx: { user: ctxUser() },
        input: input({ oAuthClientId: CLIENT_ID }),
      })
    ).rejects.toThrow(/does not belong/i);
  });

  it("scopes the client lookup to the caller's organization", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ oAuthClientId: CLIENT_ID }),
    });

    expect(prismaMock.platformOAuthClient.findFirst).toHaveBeenCalledWith({
      where: { id: CLIENT_ID, organizationId: ORG_ID },
      select: { id: true },
    });
  });

  it("runs no authorization queries when no client is given", async () => {
    await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input(),
    });

    expect(prismaMock.platformOAuthClient.findFirst).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`

Expected: the two `rejects.toThrow` tests FAIL because the handler resolves instead of throwing.

- [ ] **Step 3: Add the `MembershipRole` import**

`TRPCError` and `prisma` are already imported in this file. Add:

```ts
import { MembershipRole } from "@calcom/prisma/enums";
```

- [ ] **Step 4: Add the guard function**

Add to `listTeamAvailability.handler.ts`, directly below `buildOAuthClientFilter`:

```ts
/**
 * The tab strip is hidden from non-admins in the UI, but that is presentation only — without
 * this check any managed user with a session could pass another environment's client id and
 * read every provider's schedule. The organization check is equally load-bearing: without it
 * an admin of one organization could read another organization's clients.
 */
async function assertCanFilterByOAuthClient({
  userId,
  teamId,
  oAuthClientId,
}: {
  userId: number;
  teamId: number | null;
  oAuthClientId: string;
}) {
  if (!teamId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Filtering availability by OAuth client requires an organization.",
    });
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_teamId: { userId, teamId } },
    select: { role: true },
  });

  if (!membership || (membership.role !== MembershipRole.OWNER && membership.role !== MembershipRole.ADMIN)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only organization owners and admins can filter availability by OAuth client.",
    });
  }

  const client = await prisma.platformOAuthClient.findFirst({
    where: { id: oAuthClientId, organizationId: teamId },
    select: { id: true },
  });

  if (!client) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `OAuth client ${oAuthClientId} does not belong to this organization.`,
    });
  }
}
```

- [ ] **Step 5: Call the guard before any branching**

In `listTeamAvailabilityHandler`, immediately after the `teamId` assignment on line 189:

```ts
export const listTeamAvailabilityHandler = async ({ ctx, input }: GetOptions) => {
  const { cursor, limit, searchString } = input;
  const teamId = input.teamId || ctx.user.organizationId;

  if (input.oAuthClientId) {
    await assertCanFilterByOAuthClient({
      userId: ctx.user.id,
      teamId,
      oAuthClientId: input.oAuthClientId,
    });
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 7: Type check**

Run: `yarn type-check:ci --force`

Expected: no new errors versus `main`.

- [ ] **Step 8: Commit**

```bash
git add packages/trpc/server/routers/viewer/availability/team/
git commit -m "fix(availability): restrict OAuth client filtering to org owners and admins"
```

---

## Task 4: Restore the timezone-buddy leaf components

**Files:**
- Create (from git): `apps/web/modules/timezone-buddy/store.ts`, `constants.ts`, `components/CellHighlightContainer.tsx`, `components/HoverOverview.tsx`, `components/TimeDial.tsx`

**Interfaces:**
- Consumes: nothing
- Produces: `TBContext` and `createTimezoneBuddyStore` from `../store`; `DAY_CELL_WIDTH` from `../constants`; named exports `TimeDial` (props `{ timezone: string; dateRanges: DateRange[] }`) and `CellHighlightContainer` (wraps children). Task 5 imports all of these.

**Context:** These five files are pure presentation with no org or EE coupling — they come back byte-for-byte. Their imports (`zustand`, `framer-motion`, `@calcom/dayjs`, `@calcom/features/schedules/lib/date-ranges`, `@calcom/ui/classNames`) all still resolve; `zustand` and `framer-motion` are declared in `packages/features/package.json`, hoisted to the root `node_modules`, and already imported from `apps/web` elsewhere. No dependency changes.

`AvailabilityEditSheet.tsx` is deliberately NOT restored (spec §2 — Lavela already writes schedules via `PATCH /v2/schedules`, and a second writer invites conflicts neither side would detect).

- [ ] **Step 1: Restore the five files verbatim**

```bash
git checkout ab21c7f805^ -- \
  apps/web/modules/timezone-buddy/store.ts \
  apps/web/modules/timezone-buddy/constants.ts \
  apps/web/modules/timezone-buddy/components/CellHighlightContainer.tsx \
  apps/web/modules/timezone-buddy/components/HoverOverview.tsx \
  apps/web/modules/timezone-buddy/components/TimeDial.tsx
```

- [ ] **Step 2: Verify the restore is byte-identical**

Run: `git diff --cached ab21c7f805^ -- apps/web/modules/timezone-buddy`

Expected: no output. Any diff means the wrong revision was used.

- [ ] **Step 3: Confirm `AvailabilityEditSheet` was not restored**

Run: `ls apps/web/modules/timezone-buddy/components/`

Expected: exactly `CellHighlightContainer.tsx`, `HoverOverview.tsx`, `TimeDial.tsx`.

- [ ] **Step 4: Type check**

Run: `yarn type-check:ci --force`

Expected: no new errors. These files have no importers yet, so they must type-check standalone.

- [ ] **Step 5: Commit**

```bash
git add apps/web/modules/timezone-buddy/
git commit -m "feat(availability): restore timezone-buddy grid components from ab21c7f805^"
```

---

## Task 5: The read-only per-client slider table

**Files:**
- Create: `apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx`
- Modify: `packages/i18n/locales/en/common.json`

**Interfaces:**
- Consumes: `TimeDial`, `CellHighlightContainer`, `TBContext`, `createTimezoneBuddyStore` (Task 4); the `oAuthClientId` input on `viewer.availability.listTeam` (Task 2)
- Produces: `export function AvailabilitySliderTable({ oAuthClientId }: { oAuthClientId: string })` and `export interface SliderUser`. Task 6 imports the component.

**Context:** Start from the upstream file, then make four changes — two removals (spec §2, §4.2) and two additions. The middle of the file (the three `ColumnDef` entries, `flatData`, `fetchMoreOnBottomReached`, `useReactTable`) is unchanged.

- [ ] **Step 1: Restore the file as a starting point**

```bash
git checkout ab21c7f805^ -- apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx
```

- [ ] **Step 2: Add the two empty-state strings**

In `packages/i18n/locales/en/common.json`, add near the other `no_*` keys:

```json
  "no_managed_users_for_client": "No managed users yet",
  "no_managed_users_for_client_description": "No users have been provisioned through this OAuth client.",
```

- [ ] **Step 3: Replace the imports block**

Replace everything above `export interface SliderUser` with:

```tsx
"use client";

import { keepPreviousData } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { getCoreRowModel, getFilteredRowModel, useReactTable } from "@tanstack/react-table";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import dayjs from "@calcom/dayjs";
import type { DateRange } from "@calcom/features/schedules/lib/date-ranges";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { CURRENT_TIMEZONE } from "@calcom/lib/timezoneConstants";
import type { MembershipRole } from "@calcom/prisma/enums";
import { trpc } from "@calcom/trpc/react";
import type { UserProfile } from "@calcom/types/UserProfile";
import { UserAvatar } from "@calcom/ui/components/avatar";
import { Button } from "@calcom/ui/components/button";
import { ButtonGroup } from "@calcom/ui/components/buttonGroup";
import { EmptyScreen } from "@calcom/ui/components/empty-screen";

import { DataTable, DataTableToolbar } from "~/data-table/components";
import { DataTableProvider } from "~/data-table/DataTableProvider";
import { useDataTable } from "~/data-table/hooks/useDataTable";

import { createTimezoneBuddyStore, TBContext } from "../store";
import { CellHighlightContainer } from "./CellHighlightContainer";
import { TimeDial } from "./TimeDial";
```

`APP_NAME`, `WEBAPP_URL`, `UpgradeTip` and `AvailabilityEditSheet` are gone; `EmptyScreen` and `useLocale` are new.

- [ ] **Step 4: Delete `UpgradeTeamTip` and replace the exported wrapper**

Delete the entire `function UpgradeTeamTip() { ... }` block. Replace the exported wrapper with:

```tsx
type AvailabilitySliderTableProps = {
  oAuthClientId: string;
};

export function AvailabilitySliderTable({ oAuthClientId }: AvailabilitySliderTableProps) {
  const pathname = usePathname();

  // Every tab shares a pathname, so without the client id in the identifier the search term
  // would leak across tabs with nothing on screen explaining the filtered result.
  return (
    <DataTableProvider tableIdentifier={`${pathname}-${oAuthClientId}`}>
      <AvailabilitySliderTableContent oAuthClientId={oAuthClientId} />
    </DataTableProvider>
  );
}
```

- [ ] **Step 5: Rewrite the content component's head**

Replace the `AvailabilitySliderTableContent` signature and its state/query block, down to and including the `useInfiniteQuery` call, with:

```tsx
function AvailabilitySliderTableContent({ oAuthClientId }: AvailabilitySliderTableProps) {
  const { t } = useLocale();
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [browsingDate, setBrowsingDate] = useState(dayjs());
  const { searchTerm } = useDataTable();

  const { data, isPending, fetchNextPage, isFetching } = trpc.viewer.availability.listTeam.useInfiniteQuery(
    {
      limit: 10,
      loggedInUsersTz: CURRENT_TIMEZONE,
      startDate: browsingDate.startOf("day").toISOString(),
      endDate: browsingDate.endOf("day").toISOString(),
      searchString: searchTerm,
      oAuthClientId,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      placeholderData: keepPreviousData,
    }
  );
```

The `editSheetOpen` and `selectedUser` state declarations are deleted.

- [ ] **Step 6: Replace the empty state and the render block**

Replace everything from the `// This means they are not apart of any teams` comment to the end of the function with:

```tsx
  if (!isPending && !flatData.length) {
    return (
      <EmptyScreen
        Icon="clock"
        headline={t("no_managed_users_for_client")}
        description={t("no_managed_users_for_client_description")}
      />
    );
  }

  return (
    <TBContext.Provider
      value={createTimezoneBuddyStore({
        browsingDate: browsingDate.toDate(),
      })}>
      <CellHighlightContainer>
        <DataTable
          table={table}
          tableContainerRef={tableContainerRef}
          isPending={isPending}
          onScroll={(e) => fetchMoreOnBottomReached(e.target as HTMLDivElement)}>
          <DataTableToolbar.Root>
            <DataTableToolbar.SearchBar />
          </DataTableToolbar.Root>
        </DataTable>
      </CellHighlightContainer>
    </TBContext.Provider>
  );
}
```

`onRowMouseclick` is gone, so rows are no longer clickable — which is what makes it read-only.

- [ ] **Step 7: Type check**

Run: `yarn type-check:ci --force`

Expected: no new errors. If `props.isOrg` still resolves anywhere, a removal was missed.

- [ ] **Step 8: Verify no edit-sheet references survive**

Run: `rg -n "AvailabilityEditSheet|isOrg|UpgradeTeamTip" apps/web/modules/timezone-buddy/`

Expected: no matches.

- [ ] **Step 9: Commit**

```bash
git add apps/web/modules/timezone-buddy/ packages/i18n/locales/en/common.json
git commit -m "feat(availability): add read-only per-client availability slider table"
```

---

## Task 6: The tab strip and page wiring

**Files:**
- Modify: `apps/web/modules/availability/availability-view.tsx:181-187`
- Modify: `apps/web/app/(use-page-wrapper)/(main-nav)/availability/page.tsx`

**Interfaces:**
- Consumes: `AvailabilitySliderTable` (Task 5); `PlatformOAuthClientRepository` (Task 1)
- Produces: `AvailabilityCTA` gains a required `oAuthClients: { id: string; name: string }[]` prop

**Context:** `AvailabilityCTA` is currently just a `NewScheduleButton`. `session.user.org.role` carries the viewer's `MembershipRole` (`packages/types/next-auth.d.ts:38`), so the gate needs no round trip. `useCompatSearchParams` returns a `ReadonlyURLSearchParams` and never null, so `.get()` and `.toString()` are safe without a guard.

- [ ] **Step 1: Rewrite `AvailabilityCTA`**

In `availability-view.tsx`, widen the `next/navigation` import to `import { useRouter, usePathname } from "next/navigation";` and add:

```tsx
import { useCompatSearchParams } from "@calcom/lib/hooks/useCompatSearchParams";
import { ToggleGroup } from "@calcom/ui/components/form";
```

Then replace the `AvailabilityCTA` export with:

```tsx
const MY_AVAILABILITY = "mine";

type AvailabilityCTAProps = {
  oAuthClients: { id: string; name: string }[];
};

export const AvailabilityCTA = ({ oAuthClients }: AvailabilityCTAProps) => {
  const searchParams = useCompatSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useLocale();

  const onValueChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === MY_AVAILABILITY) {
      params.delete("client");
    } else {
      params.set("client", value);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <div className="flex items-center gap-2">
      {oAuthClients.length > 0 && (
        <ToggleGroup
          className="hidden md:block"
          value={searchParams.get("client") ?? MY_AVAILABILITY}
          onValueChange={onValueChange}
          options={[
            { value: MY_AVAILABILITY, label: t("my_availability") },
            ...oAuthClients.map((client) => ({ value: client.id, label: client.name })),
          ]}
        />
      )}
      <NewScheduleButton />
    </div>
  );
};
```

- [ ] **Step 2: Gate and fetch clients in `page.tsx`**

Add these imports:

```tsx
import { PlatformOAuthClientRepository } from "@calcom/features/platform-oauth-client/platform-oauth-client.repository";
import { MembershipRole } from "@calcom/prisma/enums";
import { AvailabilitySliderTable } from "~/timezone-buddy/components/AvailabilitySliderTable";
```

Then, immediately after the existing `if (!session?.user?.id) { return redirect("/auth/login"); }`:

```tsx
  const organizationId = session.user.profile?.organizationId ?? session.user.org?.id;
  const orgRole = session.user.org?.role;
  const canViewClients =
    !!organizationId && (orgRole === MembershipRole.OWNER || orgRole === MembershipRole.ADMIN);

  const oAuthClients = canViewClients
    ? await new PlatformOAuthClientRepository().findByOrganizationId(organizationId)
    : [];

  const requestedClientId = typeof searchParams?.client === "string" ? searchParams.client : undefined;
  // An unknown id degrades to the schedule list rather than erroring, so a bookmark kept
  // after a client is deleted still opens the page.
  const activeClient = oAuthClients.find((client) => client.id === requestedClientId);
```

- [ ] **Step 3: Branch before fetching schedules**

Insert this early return above the existing `const cachedAvailabilities = ...` line, so a client tab does not pay for a schedule fetch it will not render:

```tsx
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
```

- [ ] **Step 4: Pass the clients to the existing render path**

In the existing return at the bottom of the file, change the CTA line to:

```tsx
        CTA={<AvailabilityCTA oAuthClients={oAuthClients} />}
```

- [ ] **Step 5: Type check**

Run: `yarn type-check:ci --force`

Expected: no new errors versus `main`.

- [ ] **Step 6: Lint and format**

Run: `yarn biome check --write .`

Expected: clean, with only this task's files rewritten.

- [ ] **Step 7: Commit**

```bash
git add apps/web/modules/availability/availability-view.tsx "apps/web/app/(use-page-wrapper)/(main-nav)/availability/page.tsx"
git commit -m "feat(availability): add per-OAuth-client tabs to the availability page"
```

---

## Task 7: Documentation and final verification

**Files:**
- Modify: `agents/lavela-health-integration.md` (§9)

**Interfaces:**
- Consumes: everything above
- Produces: the draft PR

**Context:** `CLAUDE.md` requires this doc updated in the same PR as any change touching what it describes. §9 lists the admin-facing surfaces Lavela staff use on this instance; this adds one. The §1 dependency on `addToOAuthClient` must be recorded — it is the single point of failure for the whole view, and nothing in this repo's tests would catch its removal.

- [ ] **Step 1: Add the new surface to §9**

Append to §9 of `agents/lavela-health-integration.md`:

```markdown
Org owners and admins can also open `{web_url}/availability?client={oAuthClientId}`, which
lists the availability of managed users provisioned through that OAuth client — the only
place in the UI where the Development / Staging / Production split described in §12 is
visible. The tab strip is hidden from members, and the underlying
`viewer.availability.listTeam` procedure re-checks the caller's role and the client's
organization server-side.

This view depends on managed-user creation calling `addToOAuthClient`
(`apps/api/v2/src/modules/users/users.repository.ts`), which writes the
`User.platformOAuthClients` link. Nothing else in this repo reads that link and no test
covers it — if creation stops writing it, every tab silently empties.
```

- [ ] **Step 2: Run the full relevant test suite**

Run:
```bash
TZ=UTC yarn vitest run \
  packages/features/platform-oauth-client/platform-oauth-client.repository.test.ts \
  packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts
```

Expected: PASS, 10 tests total.

- [ ] **Step 3: Final type check**

Run: `yarn type-check:ci --force`

Expected: no new errors versus `main`. If errors appear in files you did not touch, run the same command on `main` and diff the output before concluding they are unrelated.

- [ ] **Step 4: Final lint**

Run: `yarn biome check --write .`

Expected: clean.

- [ ] **Step 5: Confirm the diff matches what was agreed**

Run: `git diff --stat main...HEAD`

Expected: roughly 930 lines across 14 code files plus docs. This exceeds the `CLAUDE.md` guidelines by prior agreement (spec §6) — note it in the PR body rather than splitting.

- [ ] **Step 6: Open the draft PR**

```bash
git push -u origin HEAD
gh pr create --draft \
  --title "feat(availability): group managed-user availability by platform OAuth client" \
  --body "$(cat <<'BODY'
Adds tabs to `/availability` listing managed users' availability per platform OAuth
client, so Development / Staging / Production can be inspected separately. They share one
database and one organization and are separated only by OAuth client (integration doc §12).

Design: `specs/availability-oauth-client-tabs/design.md`

## Notes for review

- **Size.** ~930 lines / 14 code files, over the CLAUDE.md guidelines. Deliberate and
  agreed — see spec §6. 564 of those lines are a mechanical restore of components deleted
  in `ab21c7f805`, verifiable with
  `git diff ab21c7f805^ -- apps/web/modules/timezone-buddy`.
- **Authorization is server-side.** The tab strip is hidden from non-admins, but
  `listTeam` independently re-checks the caller's role and that the client belongs to
  their organization. Without both, any managed user with a session could read every
  provider's schedule.
- **Read-only by design.** `AvailabilityEditSheet` was not restored — Lavela already
  writes provider schedules via `PATCH /v2/schedules`, and a second writer invites
  conflicts neither side would detect.
- **Known debt, out of scope.** `listTeamAvailability.handler.ts` calls `prisma` directly
  from a tRPC handler, against the repository rule. Extracting it would roughly double an
  already oversized PR. Spec §7.
BODY
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 Why users, not teams — depends on `addToOAuthClient` | 7 (documented) |
| §2 What the view shows; no edit sheet | 4 (not restored), 5 (read-only render) |
| §3.1 Filtering, both queries | 2 |
| §3.2 Authorization, both checks | 3 |
| §3.3 Members with no client | 2 — the `some` filter excludes them; no extra code |
| §3.4 Enumerating tabs, never `secret` | 1 |
| §4.1 Restored files | 4 |
| §4.2 `AvailabilitySliderTable` edits, table identifier, i18n keys | 5 |
| §4.3 Navigation, `?client=<id>`, hidden for non-admins | 6 |
| §4.4 `page.tsx` three-way branch | 6 |
| §5 Testing | 1, 2, 3 |
| §6 One PR | 7 |
| §8 Documentation | 7 |
| Appendix B.1 tab order | 1 — `orderBy: { createdAt: "asc" }` |

**Type consistency:** `PlatformOAuthClientListItem` (Task 1) is the element type returned by `findByOrganizationId`, consumed structurally by `AvailabilityCTA`'s `oAuthClients: { id: string; name: string }[]` (Task 6). `oAuthClientId: string` is the prop name in Task 5 and the input field name in Task 2. `buildOAuthClientFilter` is defined in Task 2 Step 4 and reused in Task 3 Step 4.

**Not covered by tests, by choice:** the frontend. Spec §5 rules out E2E, and there is no component-test precedent for this table in the repo. The type checker plus the two greps in Task 5 Steps 7–8 are the only automated guards on Tasks 4–6, so Tasks 4–6 need a human looking at the page.
