# Availability tabs per platform OAuth client

**Status:** Design approved, not implemented
**Date:** 2026-09-09

## Goal

Give org admins a `/availability` view that lists managed users' availability grouped by
the platform OAuth client that provisioned them, so Lavela staff can inspect one
environment at a time.

This instance separates Development, Staging and Production by OAuth client alone. Per
[§12 of the integration doc](../../agents/lavela-health-integration.md), staging and
production "both point at `cal.lavelahealth.com` ... separated only by OAuth client",
sharing one database, one organization and one set of admin accounts. Every managed user
is a plain `MEMBER` of that single org, so any org-wide member view mixes all three
environments into one undifferentiated list.

Upstream had a view close to what is needed — a "Team availability" tab on `/availability`
— but it was deleted wholesale in `ab21c7f805` (`refactor: Cal.diy (#28903)`), the commit
that removed the Enterprise Edition. That commit dropped 411k lines including all of
`packages/features/ee`. Team availability was collateral damage: its visibility gate read
`getOrganizationRepository().checkIfPrivate()` and the PBAC permission service, both
org-scoped EE surfaces, so the UI went out with the gate.

The backend survived intact and orphaned. `viewer.availability.listTeam`
(`packages/trpc/server/routers/viewer/availability/_router.tsx:31`) and its handler are
complete and have zero callers anywhere in the repo.

## Decisions

| Question              | Decision                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tab order             | `orderBy: { createdAt: "asc" }` — creation order, deterministic. Resolves Appendix B.1                         |
| Grouping unit         | Managed users, via the `User.platformOAuthClients` M2M. Not teams — none exist. See [§1](#1-why-users-not-teams) |
| Filter location       | An optional `oAuthClientId` on the existing `listTeam` procedure, not a new procedure. [Appendix A](#appendix-a--rejected-alternatives) |
| Navigation            | One flat toggle strip: `My availability \| Development \| Staging \| Production`                              |
| Tab contents          | The restored slider grid, read-only. `AvailabilityEditSheet` is not restored. [§4](#4-frontend)               |
| Unlinked members      | Hidden. No "All" or "Unassigned" tab. [§3.3](#33-members-with-no-client)                                       |
| Visibility            | Org `OWNER` and `ADMIN` only, enforced server-side as well as in the UI. [§3.2](#32-authorization)             |
| Delivery              | One PR, deliberately over the size guideline. [§6](#6-pr-size)                                                 |

## 1. Why users, not teams

Managed users are created through `createNewUsersConnectToOrgIfExists` with
`teamId: organizationId` and `role: "MEMBER"`
(`apps/api/v2/src/modules/oauth-clients/services/oauth-clients-users.service.ts:47`), so
they are direct members of the one platform org. No per-environment teams exist, and
Lavela's consumed API surface (§10 of the integration doc) contains no team endpoints.

The client link lives on the user. `User.platformOAuthClients` is an implicit many-to-many
(`packages/prisma/schema.prisma:477`) populated at creation time by `addToOAuthClient`
(`apps/api/v2/src/modules/users/users.repository.ts:38`).

`Team.createdByOAuthClientId` (`schema.prisma:610`) exists and would be the natural
grouping key if teams were used, but nothing in this fork writes it. Grouping by it today
would produce three empty tabs.

**This design depends on that link.** If managed-user creation ever stops calling
`addToOAuthClient`, every tab silently empties. That coupling is recorded in §9 of the
integration doc as part of this change.

## 2. What the view shows

Per tab, a `DataTable` with three columns, restored from upstream:

| Column   | Contents                                                          |
| -------- | ----------------------------------------------------------------- |
| Member   | Avatar, username, timezone                                        |
| Timezone | Current local time and GMT offset                                 |
| Slider   | `TimeDial` availability bands for the browsed day, with date nav  |

Cursor-paginated at 10 rows per page via `useInfiniteQuery`, with a search bar.

Read-only. `AvailabilityEditSheet` — which let an admin rewrite a member's schedule in
place — is deliberately not restored: Lavela already writes provider schedules through
`POST/PATCH /v2/schedules`, and a second writer on the same rows invites conflicts that
neither side would detect.

## 3. Backend

### 3.1 Filtering

Add `oAuthClientId: z.string().optional()` to `ZListTeamAvailaiblityScheme`
(`.../availability/team/listTeamAvailability.schema.ts`). Optional and additive, so the
existing contract is unchanged and the procedure stays compatible with upstream's shape.

For an org admin, `listTeamAvailabilityHandler` resolves
`const teamId = input.teamId || ctx.user.organizationId` (line 189) and takes the
single-team branch. The filter must land in **two** queries on that path:

- `getTeamMembers`, at the `prisma.membership.findMany` on line 36
- the `prisma.membership.count` on line 216

as `user: { platformOAuthClients: { some: { id: oAuthClientId } } }`, spread conditionally
the way `searchString` already is.

Both are required. The count feeds `meta.totalRowCount`, which the table compares against
rows fetched to decide whether to keep paginating. Filtering only the rows would report
every org member on every tab, and the table would fetch past the end of the filtered set.

`getInfoForAllTeams` (line 145) is the no-`teamId` fallback and is not reached by this
feature, since an org admin always resolves a `teamId`. It is left untouched.

### 3.2 Authorization

Gating the strip in `page.tsx` is presentation only. The handler must enforce
independently — otherwise any managed user with a web session could call `listTeam` with
another environment's client id and enumerate every provider's schedule.

When `oAuthClientId` is present, the handler additionally requires:

1. the caller's membership role on `teamId` is `OWNER` or `ADMIN`
2. the client belongs to that organization

Check 1 alone is insufficient: without check 2, a legitimate admin of one org could read a
different org's clients. Both are cheap — the membership row is already fetched at line
201, and the client's `organizationId` is a single indexed lookup.

### 3.3 Members with no client

Org admins and any seeded accounts have no `platformOAuthClients` row. With the `some`
filter they simply never match, so they appear in no tab. This is intended: the view is
"managed users per environment", and an admin's own availability is already on the
default tab.

### 3.4 Enumerating the tabs

Add `findByOrganizationId(organizationId)` to `PlatformOAuthClientRepository`
(`packages/features/platform-oauth-client/platform-oauth-client.repository.ts:8`, which
today has only `getByUserId`), selecting `id` and `name` only. **Never select `secret`.**

Declare it on `IPlatformOAuthClientRepository` too. Note that `getByUserId` is typed
`Promise<PlatformOAuthClient | null>` — the full model, `secret` included — so the new
method must declare its own narrowed return type rather than reuse that shape. Retyping
`getByUserId` is a pre-existing concern and out of scope here.

`page.tsx` is a server component that already resolves the session, so it calls this
directly. The alternative — the existing `useOAuthClients()` hook
(`apps/web/lib/hooks/settings/platform/oauth-clients/useOAuthClients.ts`), which fetches
`GET /api/v2/oauth-clients` — would make the tab strip pop in after hydration and couple
the page to API v2 being reachable.

## 4. Frontend

### 4.1 Restored from `ab21c7f805^`

Verbatim, no org or EE coupling:

| File                                    | Lines |
| --------------------------------------- | ----- |
| `timezone-buddy/store.ts`               | 94    |
| `timezone-buddy/constants.ts`           | 1     |
| `components/CellHighlightContainer.tsx` | 80    |
| `components/HoverOverview.tsx`          | 149   |
| `components/TimeDial.tsx`               | 240   |

Not restored: `AvailabilityEditSheet.tsx` (254 lines), per §2.

### 4.2 `AvailabilitySliderTable.tsx`

Restored with edits (272 lines before changes):

- Remove the `isOrg` prop, `onRowMouseclick`, the `editSheetOpen` / `selectedUser` state,
  and the `AvailabilityEditSheet` render.
- Replace the `UpgradeTeamTip` empty state. It renders an `UpgradeTip` with `plan="team"`
  and a *Create team* button pointing at `/settings/teams/new` — meaningless when the real
  condition is "this OAuth client has no managed users yet". A plain `EmptyScreen`
  replaces it, adding two keys to `packages/i18n/locales/en/common.json`:
  `no_managed_users_for_client` and `no_managed_users_for_client_description`.
- Add an `oAuthClientId` prop, passed into the `listTeam` infinite query.
- Fold the client id into `DataTableProvider`'s `tableIdentifier`, which is currently just
  `pathname`. All tabs share a pathname, so as written the search term would persist
  across tab switches — type a name on Staging, switch to Production, and the list is
  still filtered with nothing on screen explaining why.

### 4.3 Navigation

`AvailabilityCTA` in `apps/web/modules/availability/availability-view.tsx` is today just a
`NewScheduleButton`. It regains a `ToggleGroup`: *My availability* first, then one entry
per client, in the order the repository returns them.

No new translation keys for the strip itself. `my_availability` already exists
(`packages/i18n/locales/en/common.json:2940`), and client names are user-supplied data
that is never translated. `team_availability` (line 2941) stays unused, as it is today.

Selection writes `?client=<id>`; absent means my availability. Tabs are therefore
linkable and survive a refresh.

When the viewer is not `OWNER` or `ADMIN`, `page.tsx` passes an empty client list and the
strip does not render, leaving today's exact UI.

The role must be read from the membership, **not** from `session.user.org.role`.
`next-auth-options.ts` sets `org` only when `profileOrg && !profileOrg.isPlatform`, so it
is always `null` on this instance — the org created by `setup-platform-org.ts` has
`isPlatform: true`. `page.tsx` therefore calls
`MembershipRepository.findRoleByUserIdAndTeamId`. The org id itself is fine from the
session: `session.user.profile.organizationId` is populated for platform users.

The tRPC handler is unaffected — `ctx.user.organizationId` derives from
`user.profile?.organization?.id` (`userFromSessionUtils.ts:81`), not from the `org` claim.

### 4.4 `page.tsx`

Branches on the param:

| `?client`             | Renders                                   |
| --------------------- | ----------------------------------------- |
| absent                | `AvailabilityList` (today's behaviour)     |
| matches a fetched id  | `AvailabilitySliderTable`                  |
| does not match        | `AvailabilityList`                         |

The third row matters: deleting an OAuth client should make a stale bookmark degrade
quietly to the schedule list, not error.

## 5. Testing

Handler tests follow the established pattern — `prismaMock` from
`@calcom/testing/lib/__mocks__/prismaMock` with vitest, as in
`getAllSchedulesByUserId.handler.test.ts`. Run with `TZ=UTC`.

| Case                                                  | Asserts                                        |
| ----------------------------------------------------- | ---------------------------------------------- |
| `oAuthClientId` present                               | Filter reaches both the member query and count |
| Caller is `MEMBER`, passes `oAuthClientId`            | Rejected, not silently returning rows          |
| Caller is `OWNER` of org A, passes org B's client     | Rejected                                       |
| No `oAuthClientId`                                    | Behaviour identical to today                   |

Plus a repository test that `findByOrganizationId` never selects `secret`.

No E2E. Upstream's `team-availability.e2e.ts` died in the same commit, and E2E here runs
only behind the `ready-for-e2e` label.

## 6. PR size

**One PR, roughly 930 lines across 14 code files.** This exceeds both guidelines in
`CLAUDE.md` (500 lines, 10 files). Documentation files are excluded from the count by
that guideline's own terms.

| Area     | Files                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| Backend  | schema, handler, repository, repository interface, 2 test files                            |
| Frontend | 5 restored, `AvailabilitySliderTable`, `availability-view.tsx`, `page.tsx`                |
| Docs     | `agents/lavela-health-integration.md`, this spec — excluded from the count                 |

This is a deliberate, explicit choice by the repository owner, recorded here so it is not
mistaken for an oversight and "corrected" by a later agent. Two split options were offered
and declined: backend/frontend as two PRs, and a further split isolating the verbatim
restore. The bulk of the diff — 564 of ~930 lines — is a mechanical revert verifiable with
`git diff ab21c7f805^ -- apps/web/modules/timezone-buddy`.

## 7. Out of scope

- Restoring `AvailabilityEditSheet` or any write path (§2)
- Extracting `listTeamAvailability.handler.ts` off direct `prisma` access. It violates the
  repository rule in `CLAUDE.md`, but folding the refactor in would roughly double an
  already oversized PR. Worth a follow-up.
- Per-environment teams, or writing `Team.createdByOAuthClientId`
- Any change to API v2 or to the endpoints Lavela consumes

## 8. Documentation

`agents/lavela-health-integration.md` §9 describes the admin-facing surfaces Lavela staff
use on this instance. This adds one, and must be added there in the same PR — including
the §1 dependency on `addToOAuthClient`, which is the single point of failure for the
whole view.

No §11 invariant is affected and no consumed endpoint changes.

## Appendix A — rejected alternatives

**A separate `listByOAuthClient` procedure.** Cleaner conceptually — the platform concern
would not leak into the generic team endpoint — but it duplicates `buildMember` and the
entire date-range block, leaving two handlers to keep in sync. Justified only if the
platform view is expected to diverge substantially from the team view. It is not.

**Client-side grouping.** Fetch all org members with their client links and bucket them in
the browser; no backend change. Rejected: `listTeam` is cursor-paginated at 10 rows per
page, so a client-side filter would render "3 of 10" on a tab and paginate against the
unfiltered total. Making it work means abandoning pagination.

**Client as a dropdown filter rather than tabs.** Scales better to many clients and matches
how the data table already does filtering, but makes the environment — the single most
important thing about a row here — the least prominent element on the page.

**An "All" or "Unassigned" tab.** Rejected as unnecessary: the question the view answers is
always about one environment, and admins' own availability is already on the default tab.

## Appendix B — open questions

1. ~~**Tab order.**~~ Resolved during planning: `findByOrganizationId` sorts by
   `createdAt` ascending, which is deterministic and matches the order the clients were
   created in.
2. **A user linked to more than one client.** The schema permits it; nothing in the
   creation path produces it today. Such a user would appear under every client they are
   linked to. This is the correct behaviour, but worth knowing before it is seen.
