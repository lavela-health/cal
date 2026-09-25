# Persist history of provider availability and overrides

**Status:** approved design, 2026-09-25 · **Repo:** `lavela-health/cal` · **Consumer changes:** none
**Ticket:** [Provider availability — Persist history of availability and overrides](https://app.asana.com/1/1201847314396064/project/1214341179219738/task/1218109876343992)
**Supersedes:** the exploration note `cal-availability-history.md` attached to the ticket on 2026-09-21.
That note proposed three PRs and left five decisions open; this spec resolves all five and lands the
work as **one PR**, at Lucas's direction.

## 1. Problem

Cal stores only the current state of a schedule, so a provider's past availability is unrecoverable.
Two mechanisms combine to destroy it, both verified against the tree at `89115e779d`:

**The storage model has no time dimension.** `Availability` (`packages/prisma/schema.prisma:960`)
holds `days`, `startTime`, `endTime`, `date`, `scheduleId` and nothing else — no `createdAt`, no
`updatedAt`. Weekly rules and date overrides share the table, distinguished only by whether `date` is
null. The rows sitting there now cannot say when they were written.

**Every save through the atom wipes the schedule.** `ScheduleService#update`
(`packages/features/schedules/services/ScheduleService.ts:114-127`) issues an unqualified
`deleteMany: { scheduleId }` followed by `createMany` of whatever the form submitted. The form is
populated by `transformDateOverridesForAtom` (`packages/lib/schedules/transformers/for-atom.ts:35-39`),
which drops every override before today:

```ts
if (!override.date || dayjs(override.date).isBefore(currentTimeInTz, "day")) {
  return acc;
}
```

So past overrides survive only until the provider next opens their schedule page — the
`AvailabilitySettings` atom embedded at `/provider/availability` in lavela-health, which they reach
constantly.

The REST path is **not** destructive in the same way: `schedules.repository.ts:130-146` deletes only
the category present in the payload, keyed on `date IS NULL`. This is why `Cal::BlockOutOfOffice` —
which sends only `overrides` — preserves past overrides today. The two paths must stay different.

### The feature that already lies

PR [#5](https://github.com/lavela-health/cal/pull/5) rebuilt `/availability` as the fleet view, and
`AvailabilitySliderTable` already pages through dates: `browsingDate` in state, chevrons stepping it
a day at a time (`AvailabilitySliderTable.tsx:191,194`), feeding `startDate`/`endDate` into
`listTeamAvailability`. You can browse to August right now and get a confident, wrong answer, because
`buildMember` reads live rows regardless of the date asked for
(`listTeamAvailability.handler.ts:118-124`):

```ts
const schedule = await prisma.schedule.findUnique({
  where: { id: member.user.defaultScheduleId },
  select: { availability: true, timeZone: true },   // always current
});
```

**This is the ticket restated.** The UI, the tabs, the date navigation and the per-provider dial all
shipped in #5. What is missing is the ability to ask *what did this schedule look like on that date* —
and until that exists, an existing feature reports fiction for past dates.

## 2. Goal and non-goals

**Goal.** From rollout onward, every change to a provider's weekly schedule or date overrides is
recorded with effective dates, and an admin can reconstruct what any provider's scheduled availability
was on any past date.

**Non-goals, decided rather than deferred by omission:**

- **Recovering August 2026.** Aretha Hampton's August overrides are already deleted and there is no
  source to recover them from. The occupancy report that motivated this ticket cannot be produced for
  August; it becomes possible from rollout forward.
- **An occupancy range view.** AC4 says "date or date range"; this spec delivers the date half. See
  §4.3.
- **Actor capture.** No AC asks who made a change, and a database trigger cannot see the Cal session.
  See §4.5.

### A caveat that belongs on any report built from this

"Bookable" is narrower than it sounds. AC4 scopes reconstruction to weekly schedule plus overrides.
Real bookable availability also subtracts connected-calendar busy time (`:provider_calendar_sync`) and
applies `minimumBookingNotice`. Google busy data is never stored on our side, so anything reconstructed
here is **scheduled** availability, not **offered** availability. If an occupancy report is read as the
latter, that gap belongs on the report itself.

## 3. Design

### 3.1 Data model

```prisma
model ScheduleVersion {
  id           Int       @id @default(autoincrement())
  scheduleId   Int       // soft reference — deliberately no FK, see below
  userId       Int       // denormalised so history survives schedule deletion
  timeZone     String?
  availability Json      // [{ days, startTime, endTime, date }] — the full set as saved
  validFrom    DateTime  @default(now())
  validTo      DateTime? // null = current version
  txId         BigInt    // txid_current(), for trigger idempotency

  @@unique([scheduleId, txId])
  @@index([scheduleId, validFrom])
  @@index([userId, validFrom])
}
```

**Version-per-save, not row-level audit.** Every write is already a wholesale replace of the schedule's
rows, so a snapshot is the faithful unit of change, and reconstruction is a single indexed query
(`the row whose validFrom <= t < validTo`). Row-level auditing is more normalised but must be
reassembled per read, for no gain any AC asks for.

**No foreign key on `scheduleId`.** `onDelete: Cascade` would destroy history when a schedule is
deleted — precisely the failure this work exists to prevent — and `SetNull` would orphan it. The repo
already documents this soft-reference pattern on `AuditActor` (`schema.prisma:2451-2458`) for exactly
this reason. `userId` is denormalised for the same purpose: history remains queryable per provider
after the schedule row is gone.

**`availability` as `Json`.** One row per version keeps reconstruction to one query and matches the
version-per-save model. No acceptance criterion requires querying inside the snapshot. Note that
`startTime`/`endTime` are `@db.Time` and `date` is `@db.Date`; they serialise as strings and the
repository is responsible for mapping them back (§3.3).

**`txId`.** Carries `txid_current()` so the trigger can collapse its own repeated firings within one
transaction. It is an implementation detail of §3.2 made explicit in the schema rather than hidden,
because the unique index is what makes the trigger idempotent.

### 3.2 Capture: deferred constraint trigger

A hand-written migration adds one function and two triggers.

`capture_schedule_version(schedule_id int)`:

1. Reads the schedule's **current** `Availability` rows plus `Schedule.timeZone` and `Schedule.userId`,
   aggregating with a deterministic `ORDER BY date NULLS FIRST, "startTime", "endTime", days` inside
   `json_agg`. The ordering is load-bearing, not cosmetic: `json_agg` is otherwise free to return rows
   in any order, and step 2 compares snapshots by value.
2. Returns early if that snapshot equals the currently-open version, so a name-only save or a
   `setupDefaultSchedule` call does not manufacture a meaningless version.
3. Closes the open version: `UPDATE ScheduleVersion SET validTo = now() WHERE scheduleId = ?
   AND validTo IS NULL AND txId <> txid_current()`.
4. `INSERT ... ON CONFLICT (scheduleId, txId) DO UPDATE`.

Triggers, both `DEFERRABLE INITIALLY DEFERRED`:

- `AFTER INSERT OR UPDATE OR DELETE ON "Availability" FOR EACH ROW`, capturing
  `COALESCE(NEW."scheduleId", OLD."scheduleId")` and skipping NULL — `Availability` rows can belong to
  an event type or user with no schedule.
- `AFTER UPDATE OF "timeZone" ON "Schedule" FOR EACH ROW`, capturing `NEW.id`.

**Why deferred solves the hard part.** The exploration note flagged trigger shape as "the one genuinely
fiddly part": a Prisma nested write is `deleteMany` then `createMany`, so a row-level trigger fires per
row and a statement-level trigger fires twice, risking recording an intermediate state as if it were
real. Deferring to COMMIT removes the problem rather than working around it — at commit the table
already holds its final state, so there is no intermediate state to observe. Row-level firing then
becomes harmless: all N firings compute the identical snapshot, and the unique index collapses them
into one row. The trigger is idempotent by construction, not by careful ordering.

`CREATE CONSTRAINT TRIGGER` supports only `AFTER` / `FOR EACH ROW`, which is exactly what this needs.

**Coverage.** Going to the database rather than `ScheduleService` is the whole point: the trigger
catches the atom tRPC path, the REST PATCH path, the `create`/`duplicate` handlers, ops scripts and
raw SQL alike, with no way to bypass it. An application-layer implementation would have to find and
cover every write path by hand, and missing one fails silently — which is the failure mode that
created this ticket.

**Seeding.** The migration ends by inserting one version per existing schedule from its live rows, so
no schedule ever exists with availability but no history.

Postgres triggers are an established idiom here — see
`20250502130843_setup_triggers_for_booking_denormalized` and four sibling migrations.

### 3.3 Resolver

`ScheduleVersionRepository` in `packages/features/schedules/repositories/`:

```ts
availabilityAsOf(scheduleId: number, at: Date):
  Promise<{ availability: Availability[]; timeZone: string | null } | null>
```

`WHERE scheduleId = ? AND validFrom <= at AND (validTo IS NULL OR validTo > at)`, newest first,
limit 1. It maps the JSON snapshot back into the shape `buildDateRanges` already consumes, so nothing
downstream changes. Data access only — no business logic (`data-repository-methods.md` Rule 4), and the
name describes what it returns rather than who calls it (Rule 3).

**Dependency injection.** `patterns-dependency-injection.md` wants repositories resolved through a DI
container, but `listTeamAvailability.handler.ts` uses `prisma` directly and has no container. The class
takes constructor injection (`constructor(private prismaClient: PrismaClient)`) and the handler
instantiates it directly. This honours the repository pattern without dragging a DI container into a
handler that does not have one; wiring the full `tokens`/`module`/`container` trio is available later
at no cost to this design.

### 3.4 Handler seam

`buildMember` (`listTeamAvailability.handler.ts:103`) gains one branch:

```ts
const isPast = dateFrom.isBefore(dayjs().startOf("day"));
const resolved = isPast
  ? await scheduleVersionRepository.availabilityAsOf(member.user.defaultScheduleId, dateFrom.toDate())
  : null;
```

falling back to the existing live `schedule.findUnique` for today and future dates, and also when no
version covers the requested date. Resolving at `dateFrom` rather than `dateTo` gives a defensible
answer when a provider changed their schedule partway through the day in question.

This is the only behavioural change in the handler, and it introduces no new N+1 — the handler already
issues one schedule query per member.

### 3.5 UI

`apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx`:

- When `browsingDate` is in the past, blank the `nextAvailable` column. It is fed by a separate
  `nextSlots` query about the *future* and is meaningless beside a historical dial.
- Show a marker that a past date is displaying recorded history rather than a projection.
- Add a date picker beside the chevrons. Stepping to August one day at a time is roughly 40 clicks.

New strings go in `packages/i18n/locales/en/common.json`.

### 3.6 Documentation

`agents/lavela-health-integration.md` is the only record of the fork's couplings and must be updated in
the same PR:

- **§6 Availability and out-of-office** — the history table and the past-date semantics of
  `listTeamAvailability`. §6's existing claims (no local mirror in lavela-health, the OOO override
  merge) both remain true.
- **§11 Invariants** — a new invariant: availability writes are versioned, and nothing may bypass the
  trigger.

### 3.7 lavela-health

**No changes required.** The read surface is a page in the fork, already linked from its sidebar via
`Admin::HomesHelper#admin_external_tool_links`.

## 4. Resolved decisions

The exploration note left five decisions open. All five were settled in the design interview on
2026-09-25.

**4.1 History shape.** Version-per-save. Rationale in §3.1.

**4.2 Trigger shape.** Deferred constraint trigger, deduped on `txId`. This does not merely pick among
the options the note listed — it removes the intermediate-state hazard that made the choice hard. See
§3.2.

**4.3 Date or date range?** Date. Make the existing #5 dial tell the truth for past dates and add a
date picker; no new aggregate view. An occupancy range report is the real business need behind the
ticket, but it is inherently new UI plus a booked-time join, well beyond this ticket's estimate, and it
would report *scheduled* rather than *offered* availability (§2). Every byte it would need is captured
by this design, so it stays a cheap follow-up.

**4.4 Seed the `legacy_cal` snapshots?** No. Version 1 for each schedule is its current live rows at
migration time, keeping this PR entirely inside the Cal repo with no cross-database one-off.

Worth recording for whoever revisits this: `external_account.metadata['legacy_cal']` in lavela-health
holds the full `GET /v2/schedules` payload — weekly availability *and* the complete override array —
plus a `captured_at`, written by `Cal::SelfHosted::MigrateProvider#build_snapshot`. It is real data and
it is not going anywhere. But the migration landed **2026-09-01** (`e2695102`), so those snapshots
postdate August and would not answer Frances's original question. Backfilling them remains possible
later — the history table is append-only and `validFrom` is explicit.

**4.5 Actor capture.** Out of scope. No AC asks for it, and a trigger cannot see the Cal session. If
wanted later it is an application-layer audit in `ScheduleService` mirroring `BookingAudit`
(`schema.prisma:2485`) — separate work, not a widening of this.

## 5. Testing

**`ScheduleVersion.integration-test.ts`** — the load-bearing suite, against real Postgres and real
transactions, because a deferred trigger cannot be exercised against a mocked Prisma client. The repo
runs these in CI as `VITEST_MODE=integration yarn test`
(`.github/workflows/integration-tests.yml:89`), alongside 15 existing `*.integration-test.ts` files.

- An atom-shaped `deleteMany` + `createMany` in one transaction produces exactly **one** version.
- A schedule emptied to zero rows still records a version (the DELETE-only case).
- A no-op save — same availability, different name — produces **no** new version.
- Re-saving the same availability in a different row order still produces **no** new version, pinning
  the deterministic ordering in step 1 of §3.2.
- A REST-shaped partial write (overrides only) records a version and leaves weekly rules intact.
- `validTo` chains correctly across successive saves, with no gaps and no overlaps.
- A `Schedule.timeZone` change alone records a version.

**`ScheduleVersionRepository` unit tests** — boundaries at exactly `validFrom`, exactly `validTo`, no
version covering the date, and several versions in range.

**`listTeamAvailability.handler.test.ts`** — extend the suite added in #5 with past-date cases: the
schedule changed after the date asked for, an override that has elapsed and been deleted, and a
timezone change between then and now.

## 6. Acceptance criteria

- [ ] History capture is part of the in-house Cal implementation (independent of Cal.com), so every
      future schedule and override change is recorded from its rollout onward. → §3.2
- [ ] When a provider's weekly availability changes, the previous version is retained as history with
      effective dates, rather than overwritten. → §3.1, §3.2
- [ ] Date overrides are retained as history, including past overrides that have already elapsed (both
      added and blocked time). → §3.2; the trigger snapshots the whole set, so elapsed overrides are
      preserved in the version that predates their deletion.
- [ ] For any past date, an admin can determine what a provider's scheduled availability — weekly
      schedule plus overrides in effect — was at that time. → §3.3, §3.4, §3.5. The "date range" half
      of the original AC is explicitly out of scope per §4.3.

## 7. Risks and checks

- **Schema change.** `packages/prisma/schema.prisma` is on CLAUDE.md's "ask first" list. Confirm before
  running `yarn prisma migrate dev --create-only`.
- **Deferred triggers and long transactions.** Firing at COMMIT means the snapshot query runs inside
  the caller's transaction. The read is a single indexed lookup over one schedule's rows, so cost is
  negligible, but it is worth stating that this is on the write path.
- **`travelSchedules` are unversioned.** `buildMember` passes them to `buildDateRanges` alongside
  availability. Confirm they are unused for managed users rather than assuming it; if they are used,
  reconstruction is incomplete and that belongs in §6 of the integration doc.
- **The REST path must keep its current behaviour.** Verify `Cal::BlockOutOfOffice` still preserves
  past overrides once the trigger exists. The trigger only reads; it must not change which rows the
  REST repository deletes.
- **Seed and trigger creation must be in the same migration**, so no window exists where writes happen
  without capture.
- **PR size.** This exceeds CLAUDE.md's 500-line / 10-file guidance. Lucas directed one PR rather than
  the three the exploration note proposed; note it in the PR body.
