# Availability History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every change to a provider's weekly schedule and date overrides, so an admin can reconstruct what any provider's scheduled availability was on any past date.

**Architecture:** A `ScheduleVersion` table holds one JSON snapshot per schedule-save, written by a *deferred* Postgres constraint trigger that fires at COMMIT — when the table already holds its final state, so `deleteMany` + `createMany` cannot be caught mid-flight. A repository resolves "the version in effect at time *t*", and `buildMember` in the fleet-view handler uses it for past dates instead of live rows.

**Tech Stack:** PostgreSQL (plpgsql triggers), Prisma, tRPC, React, Vitest (unit + integration), Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-25-availability-history-design.md`

## Global Constraints

- **One PR**, at Lucas's direction — do not split. This exceeds CLAUDE.md's 500-line / 10-file guidance; say so in the PR body.
- Prisma queries use `select`, never `include`.
- `import type { X }` for type-only imports; no barrel imports (`@calcom/ui/components/button`, not `@calcom/ui`).
- No `as any`. Ever.
- `ErrorWithCode` in services/repositories/utilities; `TRPCError` only in tRPC routers.
- All UI strings go through `t()` and are added to `packages/i18n/locales/en/common.json`.
- Comments explain **why**, never **what**.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`.
- Run `yarn type-check:ci --force` before pushing.
- **Lint only the files you changed**: `yarn biome check --write <your files>`. Do NOT run
  `yarn biome check --write .` — it autofixes ~3000 unrelated files across the monorepo and
  leaves them as uncommitted churn. Pass explicit paths.
- `agents/lavela-health-integration.md` must be updated in this same PR (Task 5).
- Branch is `feat/availability-history`, already created off `main`.

## Review Focus

Five failure modes the spec implies that would otherwise ship untested. Each has a test assigned to the task that owns the code.

1. **A past date earlier than the first recorded version** (i.e. all of August — the motivating case) must report *no record*, never today's live rows. → Task 3, Step 1.
2. **A recorded snapshot of `[]` must stay distinguishable from "no version recorded".** A provider genuinely having zero availability is a real answer; a gap in the record is not. → Task 3, Step 1 and Task 4, Step 1.
3. **DST.** A past date on the far side of a DST transition must reconstruct with correct local times — the snapshot stores wall-clock time strings, and the mapping back to `Date` must preserve UTC time-of-day semantics. → Task 2, Step 5.
4. **Override rows carry `days: []`** and must round-trip as overrides, not be processed as weekly working hours. `buildDateRanges` discriminates on `"days" in item` and `"date" in item && !!item.date`, and every Prisma `Availability` row has both keys. → Task 2, Step 5.
5. **Concurrent commits against one schedule** must leave exactly one open version. The `(scheduleId, txId)` unique index only dedupes *within* a transaction. → Task 1, Step 9.

---

### Task 1: ScheduleVersion table, capture trigger, and seed

**Files:**
- Modify: `packages/prisma/schema.prisma` (new model, after `Availability` at :960-978)
- Create: `packages/prisma/migrations/<timestamp>_availability_history/migration.sql`
- Test: `packages/features/schedules/repositories/ScheduleVersion.integration-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: table `"ScheduleVersion"` with columns `id, scheduleId, userId, timeZone, availability, validFrom, validTo, txId`; Prisma model `ScheduleVersion` accessible as `prisma.scheduleVersion`; SQL function `capture_schedule_version(integer)`.

**Snapshot JSON shape** — every later task depends on this exact shape:

```json
[{ "days": [1,2,3], "startTime": "09:00:00", "endTime": "17:00:00", "date": null }]
```

`startTime`/`endTime` are `HH24:MI:SS` strings, `date` is `YYYY-MM-DD` or `null`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/features/schedules/repositories/ScheduleVersion.integration-test.ts`:

```ts
import prisma from "@calcom/prisma";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const uniqueEmail = () => `schedule-version-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe("ScheduleVersion capture trigger", () => {
  let userId: number;
  let scheduleId: number;

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: uniqueEmail(), username: `sv-${Date.now()}${Math.random().toString(36).slice(2, 8)}` },
      select: { id: true },
    });
    userId = user.id;

    const schedule = await prisma.schedule.create({
      data: { userId, name: "Working Hours", timeZone: "Europe/London" },
      select: { id: true },
    });
    scheduleId = schedule.id;
  });

  afterEach(async () => {
    await prisma.scheduleVersion.deleteMany({ where: { userId } });
    await prisma.availability.deleteMany({ where: { scheduleId } });
    await prisma.schedule.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const versions = () =>
    prisma.scheduleVersion.findMany({
      where: { scheduleId },
      orderBy: { validFrom: "asc" },
      select: { id: true, availability: true, timeZone: true, validFrom: true, validTo: true },
    });

  const weekly = (days: number[], start: string, end: string) => ({
    days,
    startTime: new Date(`1970-01-01T${start}:00.000Z`),
    endTime: new Date(`1970-01-01T${end}:00.000Z`),
  });

  it("records exactly one version for an atom-shaped deleteMany + createMany", async () => {
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: {
        name: "Working Hours",
        availability: {
          deleteMany: { scheduleId: { equals: scheduleId } },
          createMany: { data: [weekly([1, 2, 3], "09:00", "17:00"), weekly([4], "10:00", "12:00")] },
        },
      },
      select: { id: true },
    });

    const rows = await versions();
    expect(rows).toHaveLength(1);
    expect(rows[0].availability).toEqual([
      { days: [1, 2, 3], startTime: "09:00:00", endTime: "17:00:00", date: null },
      { days: [4], startTime: "10:00:00", endTime: "12:00:00", date: null },
    ]);
    expect(rows[0].validTo).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `VITEST_MODE=integration TZ=UTC yarn vitest run packages/features/schedules/repositories/ScheduleVersion.integration-test.ts`

Expected: FAIL — `prisma.scheduleVersion` is undefined, because neither the model nor the table exists yet.

- [ ] **Step 3: Add the Prisma model**

**Ask Lucas for explicit approval before this step** — `packages/prisma/schema.prisma` is on CLAUDE.md's "ask first" list.

Add directly below the `Availability` model (which ends at `packages/prisma/schema.prisma:978`):

```prisma
model ScheduleVersion {
  id         Int    @id @default(autoincrement())
  // Soft references, deliberately without foreign keys: cascade-deleting history when a
  // schedule is deleted is the exact data loss this table exists to prevent. Mirrors the
  // AuditActor pattern documented at schema.prisma:2451.
  scheduleId Int
  userId     Int

  timeZone     String?
  availability Json
  validFrom    DateTime  @default(now())
  validTo      DateTime?
  // txid_current() of the writing transaction, so the deferred trigger can collapse its own
  // repeated per-row firings into a single version.
  txId BigInt

  @@unique([scheduleId, txId])
  @@index([scheduleId, validFrom])
  @@index([userId, validFrom])
}
```

- [ ] **Step 4: Generate the migration skeleton**

Run: `yarn workspace @calcom/prisma prisma migrate dev --create-only --name availability_history`

This writes `packages/prisma/migrations/<timestamp>_availability_history/migration.sql` containing only the `CREATE TABLE` and three index statements. Do not apply it yet.

- [ ] **Step 5: Append the capture function to the migration**

Append to that same `migration.sql`:

```sql
-- Snapshots a schedule's current availability into ScheduleVersion.
-- Called only from deferred constraint triggers, so by the time it runs the transaction's
-- writes are final and there is no intermediate state to observe.
CREATE OR REPLACE FUNCTION capture_schedule_version(p_schedule_id INTEGER)
RETURNS VOID AS $$
DECLARE
  v_user_id    INTEGER;
  v_time_zone  TEXT;
  v_snapshot   JSONB;
  v_current    JSONB;
  v_current_tz TEXT;
  v_txid       BIGINT := txid_current();
BEGIN
  -- Serialise capture per schedule. Without this, two transactions committing against the
  -- same schedule each close the version they can see and each insert an open one, leaving
  -- two rows with validTo IS NULL and an ambiguous reconstruction.
  PERFORM pg_advisory_xact_lock(hashtext('ScheduleVersion'), p_schedule_id);

  SELECT s."userId", s."timeZone" INTO v_user_id, v_time_zone
  FROM "Schedule" s
  WHERE s.id = p_schedule_id;

  -- The schedule itself was deleted in this transaction; closing its history is the
  -- delete trigger's job, not ours.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- The ORDER BY is load-bearing, not cosmetic: json_agg is otherwise free to return rows
  -- in any order, which would make the equality check below fire spuriously.
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'days',      a.days,
               'startTime', to_char(a."startTime", 'HH24:MI:SS'),
               'endTime',   to_char(a."endTime", 'HH24:MI:SS'),
               'date',      to_char(a.date, 'YYYY-MM-DD')
             )
             ORDER BY a.date NULLS FIRST, a."startTime", a."endTime", a.days
           ),
           '[]'::jsonb
         )
    INTO v_snapshot
  FROM "Availability" a
  WHERE a."scheduleId" = p_schedule_id;

  SELECT sv.availability, sv."timeZone" INTO v_current, v_current_tz
  FROM "ScheduleVersion" sv
  WHERE sv."scheduleId" = p_schedule_id
    AND sv."validTo" IS NULL
  ORDER BY sv."validFrom" DESC
  LIMIT 1;

  -- Nothing changed. A name-only save, or a second firing of this same trigger, must not
  -- manufacture a version.
  IF FOUND
     AND v_current = v_snapshot
     AND v_current_tz IS NOT DISTINCT FROM v_time_zone THEN
    RETURN;
  END IF;

  UPDATE "ScheduleVersion"
     SET "validTo" = CURRENT_TIMESTAMP
   WHERE "scheduleId" = p_schedule_id
     AND "validTo" IS NULL
     AND "txId" <> v_txid;

  INSERT INTO "ScheduleVersion" ("scheduleId", "userId", "timeZone", "availability", "validFrom", "txId")
  VALUES (p_schedule_id, v_user_id, v_time_zone, v_snapshot, CURRENT_TIMESTAMP, v_txid)
  ON CONFLICT ("scheduleId", "txId")
  DO UPDATE SET "availability" = EXCLUDED."availability",
                "timeZone"     = EXCLUDED."timeZone",
                "userId"       = EXCLUDED."userId";

EXCEPTION
  WHEN OTHERS THEN
    -- This runs inside the saving transaction's COMMIT, so an uncaught error here would
    -- roll the provider's schedule save back. A missing version row is a far cheaper
    -- failure than a provider unable to edit their availability. The implicit
    -- subtransaction undoes this function's own partial writes, so what is left is a
    -- clean gap rather than a half-closed version. Also swallows lock deadlocks.
    RAISE WARNING 'capture_schedule_version failed for schedule %: % (%)',
      p_schedule_id, SQLERRM, SQLSTATE;
END;
$$ LANGUAGE plpgsql;
```

The `EXCEPTION` block is load-bearing and must not be removed as noise. Note it also means a broken
capture fails *quietly* in Postgres logs — which is why the Task 1 integration tests are the real
safety net, not production behaviour.

- [ ] **Step 6: Append the trigger functions and triggers**

Append to the same `migration.sql`:

```sql
CREATE OR REPLACE FUNCTION capture_schedule_version_from_availability()
RETURNS TRIGGER AS $$
BEGIN
  -- NEW is unassigned on DELETE and OLD on INSERT, so each is guarded by TG_OP rather
  -- than COALESCE'd.
  IF TG_OP <> 'INSERT' AND OLD."scheduleId" IS NOT NULL THEN
    PERFORM capture_schedule_version(OLD."scheduleId");
  END IF;

  IF TG_OP <> 'DELETE'
     AND NEW."scheduleId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId") THEN
    PERFORM capture_schedule_version(NEW."scheduleId");
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION capture_schedule_version_from_schedule()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM capture_schedule_version(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Deleting a schedule must close its history, otherwise the final version stays open
-- forever and reads as "still in effect" for every future date.
CREATE OR REPLACE FUNCTION close_schedule_version()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "ScheduleVersion"
     SET "validTo" = CURRENT_TIMESTAMP
   WHERE "scheduleId" = OLD.id
     AND "validTo" IS NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- DEFERRABLE INITIALLY DEFERRED is the whole design: these fire at COMMIT, when the
-- transaction's deleteMany + createMany have both landed and only a final state exists.
CREATE CONSTRAINT TRIGGER availability_capture_schedule_version
AFTER INSERT OR UPDATE OR DELETE ON "Availability"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION capture_schedule_version_from_availability();

-- No column list: a name-only UPDATE is filtered by the equality check inside
-- capture_schedule_version, which is cheaper to reason about than trigger-level filtering.
CREATE CONSTRAINT TRIGGER schedule_capture_schedule_version
AFTER INSERT OR UPDATE ON "Schedule"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION capture_schedule_version_from_schedule();

CREATE CONSTRAINT TRIGGER schedule_close_version_on_delete
AFTER DELETE ON "Schedule"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION close_schedule_version();
```

- [ ] **Step 7: Append the seed**

Append to the same `migration.sql`:

```sql
-- Seed one version per existing schedule by calling the same function the triggers use,
-- so the seeded rows cannot drift from live capture. All rows share this migration's txid,
-- which is fine: the unique index is on (scheduleId, txId).
SELECT capture_schedule_version(s.id) FROM "Schedule" s;
```

- [ ] **Step 8: Apply the migration and regenerate the client**

Run:
```bash
yarn workspace @calcom/prisma db-migrate
yarn prisma generate
```
Expected: migration applies cleanly; `prisma.scheduleVersion` now exists.

Then run the Step 1 test: `VITEST_MODE=integration TZ=UTC yarn vitest run packages/features/schedules/repositories/ScheduleVersion.integration-test.ts`

Expected: PASS.

- [ ] **Step 9: Add the remaining trigger tests**

Append these to the `describe` block in `ScheduleVersion.integration-test.ts`:

```ts
  it("records a version when a schedule is emptied to nothing", async () => {
    await prisma.availability.create({ data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId } });
    const before = await versions();

    await prisma.availability.deleteMany({ where: { scheduleId } });

    const rows = await versions();
    expect(rows).toHaveLength(before.length + 1);
    expect(rows.at(-1)?.availability).toEqual([]);
    expect(rows.at(-1)?.validTo).toBeNull();
    expect(rows.at(-2)?.validTo).not.toBeNull();
  });

  it("does not record a version when only the name changes", async () => {
    await prisma.availability.create({ data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId } });
    const before = await versions();

    await prisma.schedule.update({ where: { id: scheduleId }, data: { name: "Renamed" }, select: { id: true } });

    expect(await versions()).toHaveLength(before.length);
  });

  it("does not record a version when the same availability is rewritten in a different order", async () => {
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: {
        availability: {
          deleteMany: { scheduleId: { equals: scheduleId } },
          createMany: { data: [weekly([1], "09:00", "17:00"), weekly([2], "10:00", "12:00")] },
        },
      },
      select: { id: true },
    });
    const before = await versions();

    await prisma.schedule.update({
      where: { id: scheduleId },
      data: {
        availability: {
          deleteMany: { scheduleId: { equals: scheduleId } },
          createMany: { data: [weekly([2], "10:00", "12:00"), weekly([1], "09:00", "17:00")] },
        },
      },
      select: { id: true },
    });

    expect(await versions()).toHaveLength(before.length);
  });

  it("preserves an elapsed override in the version that predates its deletion", async () => {
    await prisma.availability.create({
      data: {
        days: [],
        date: new Date("2026-08-14T00:00:00.000Z"),
        startTime: new Date("1970-01-01T13:00:00.000Z"),
        endTime: new Date("1970-01-01T15:00:00.000Z"),
        scheduleId,
        userId,
      },
    });
    const withOverride = await versions();
    expect(withOverride.at(-1)?.availability).toEqual([
      { days: [], startTime: "13:00:00", endTime: "15:00:00", date: "2026-08-14" },
    ]);

    // The atom drops elapsed overrides on the next save; the earlier version must keep it.
    await prisma.availability.deleteMany({ where: { scheduleId } });

    const rows = await versions();
    expect(rows.at(-2)?.availability).toEqual([
      { days: [], startTime: "13:00:00", endTime: "15:00:00", date: "2026-08-14" },
    ]);
    expect(rows.at(-1)?.availability).toEqual([]);
  });

  it("records a version when only the timezone changes", async () => {
    const before = await versions();

    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { timeZone: "America/New_York" },
      select: { id: true },
    });

    const rows = await versions();
    expect(rows).toHaveLength(before.length + 1);
    expect(rows.at(-1)?.timeZone).toBe("America/New_York");
  });

  it("chains validTo across successive saves with no gap and no overlap", async () => {
    for (const hour of ["09:00", "10:00", "11:00"]) {
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: {
          availability: {
            deleteMany: { scheduleId: { equals: scheduleId } },
            createMany: { data: [weekly([1], hour, "17:00")] },
          },
        },
        select: { id: true },
      });
    }

    const rows = await versions();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.at(-1)?.validTo).toBeNull();
    expect(rows.filter((row) => row.validTo === null)).toHaveLength(1);
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].validTo).not.toBeNull();
      expect(rows[i].validTo!.getTime()).toBeLessThanOrEqual(rows[i + 1].validFrom.getTime());
    }
  });

  // Review Focus 5.
  it("leaves exactly one open version when two transactions commit concurrently", async () => {
    await Promise.all([
      prisma.schedule.update({
        where: { id: scheduleId },
        data: {
          availability: {
            deleteMany: { scheduleId: { equals: scheduleId } },
            createMany: { data: [weekly([1], "09:00", "17:00")] },
          },
        },
        select: { id: true },
      }),
      prisma.schedule.update({
        where: { id: scheduleId },
        data: {
          availability: {
            deleteMany: { scheduleId: { equals: scheduleId } },
            createMany: { data: [weekly([2], "10:00", "18:00")] },
          },
        },
        select: { id: true },
      }),
    ]);

    const open = (await versions()).filter((row) => row.validTo === null);
    expect(open).toHaveLength(1);
  });
```

- [ ] **Step 10: Run the full integration suite**

Run: `VITEST_MODE=integration TZ=UTC yarn vitest run packages/features/schedules/repositories/ScheduleVersion.integration-test.ts`

Expected: PASS, 8 tests.

If the concurrency test is flaky, that is a real signal, not a flaky test — the advisory lock in Step 5 is what makes it deterministic. Check it is present and that `hashtext` is being called with both arguments.

- [ ] **Step 11: Type check and commit**

```bash
yarn type-check:ci --force
yarn biome check --write <the files you changed>
git add packages/prisma/schema.prisma packages/prisma/migrations packages/features/schedules/repositories/ScheduleVersion.integration-test.ts
git commit -m "feat(availability): capture schedule version history via deferred trigger

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: ScheduleVersionRepository

**Files:**
- Create: `packages/features/schedules/repositories/ScheduleVersionRepository.ts`
- Test: `packages/features/schedules/repositories/ScheduleVersionRepository.test.ts`

**Interfaces:**
- Consumes: `prisma.scheduleVersion` and the snapshot JSON shape from Task 1.
- Produces:
  - `class ScheduleVersionRepository { constructor(prismaClient: PrismaClient); availabilityAsOf(scheduleId: number, at: Date): Promise<ScheduleVersionSnapshot | null> }`
  - `type ScheduleVersionSnapshot = { availability: ScheduleVersionAvailability[]; timeZone: string | null }`
  - `type ScheduleVersionAvailability = { days: number[]; startTime: Date; endTime: Date; date: Date | null }`

- [ ] **Step 1: Write the failing test**

Create `packages/features/schedules/repositories/ScheduleVersionRepository.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ScheduleVersionRepository } from "./ScheduleVersionRepository";

type FindFirstArgs = { where: Record<string, unknown> };

const clientReturning = (row: unknown) => {
  const findFirst = vi.fn().mockResolvedValue(row);
  return { client: { scheduleVersion: { findFirst } }, findFirst };
};

describe("ScheduleVersionRepository.availabilityAsOf", () => {
  it("returns null when no version covers the date", async () => {
    const { client } = clientReturning(null);
    const repository = new ScheduleVersionRepository(client as never);

    expect(await repository.availabilityAsOf(1, new Date("2026-08-14T00:00:00.000Z"))).toBeNull();
  });

  it("selects the version whose window contains the date", async () => {
    const { client, findFirst } = clientReturning(null);
    const repository = new ScheduleVersionRepository(client as never);
    const at = new Date("2026-08-14T00:00:00.000Z");

    await repository.availabilityAsOf(42, at);

    const args = findFirst.mock.calls[0][0] as FindFirstArgs;
    expect(args.where).toMatchObject({
      scheduleId: 42,
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gt: at } }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC yarn vitest run packages/features/schedules/repositories/ScheduleVersionRepository.test.ts`

Expected: FAIL — cannot resolve `./ScheduleVersionRepository`.

- [ ] **Step 3: Write the repository**

Create `packages/features/schedules/repositories/ScheduleVersionRepository.ts`:

```ts
import type { PrismaClient } from "@calcom/prisma";

export type ScheduleVersionAvailability = {
  days: number[];
  startTime: Date;
  endTime: Date;
  date: Date | null;
};

export type ScheduleVersionSnapshot = {
  availability: ScheduleVersionAvailability[];
  timeZone: string | null;
};

type StoredAvailability = {
  days: number[];
  startTime: string;
  endTime: string;
  date: string | null;
};

// buildDateRanges reads wall-clock time off these via getUTCHours()/getUTCMinutes(), matching
// how Prisma surfaces a @db.Time column. Anchoring to the epoch preserves that contract.
const toTime = (value: string) => new Date(`1970-01-01T${value}.000Z`);

const toAvailability = (stored: StoredAvailability): ScheduleVersionAvailability => ({
  days: stored.days,
  startTime: toTime(stored.startTime),
  endTime: toTime(stored.endTime),
  date: stored.date ? new Date(`${stored.date}T00:00:00.000Z`) : null,
});

export class ScheduleVersionRepository {
  constructor(private prismaClient: PrismaClient) {}

  async availabilityAsOf(scheduleId: number, at: Date): Promise<ScheduleVersionSnapshot | null> {
    const version = await this.prismaClient.scheduleVersion.findFirst({
      where: {
        scheduleId,
        validFrom: { lte: at },
        OR: [{ validTo: null }, { validTo: { gt: at } }],
      },
      orderBy: { validFrom: "desc" },
      select: { availability: true, timeZone: true },
    });

    if (!version) {
      return null;
    }

    return {
      timeZone: version.timeZone,
      availability: (version.availability as StoredAvailability[]).map(toAvailability),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TZ=UTC yarn vitest run packages/features/schedules/repositories/ScheduleVersionRepository.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Add the mapping tests**

These cover Review Focus 3 (DST) and 4 (override rows). Append inside the `describe` block:

```ts
  it("maps stored times to Dates whose UTC time-of-day is the wall-clock time", async () => {
    const { client } = clientReturning({
      timeZone: "Europe/London",
      availability: [{ days: [1, 2], startTime: "09:30:00", endTime: "17:15:00", date: null }],
    });
    const repository = new ScheduleVersionRepository(client as never);

    const snapshot = await repository.availabilityAsOf(1, new Date("2026-08-14T00:00:00.000Z"));

    const [rule] = snapshot!.availability;
    expect(rule.startTime.getUTCHours()).toBe(9);
    expect(rule.startTime.getUTCMinutes()).toBe(30);
    expect(rule.endTime.getUTCHours()).toBe(17);
    expect(rule.endTime.getUTCMinutes()).toBe(15);
    expect(rule.date).toBeNull();
  });

  // Review Focus 3: the snapshot stores wall-clock time, so a reconstruction on either side
  // of a DST boundary must yield the same UTC time-of-day. The zone shift is applied later,
  // by buildDateRanges.
  it("maps identically regardless of which side of a DST boundary the date falls on", async () => {
    const { client } = clientReturning({
      timeZone: "Europe/London",
      availability: [{ days: [1], startTime: "09:00:00", endTime: "17:00:00", date: null }],
    });
    const repository = new ScheduleVersionRepository(client as never);

    const summer = await repository.availabilityAsOf(1, new Date("2026-08-14T00:00:00.000Z"));
    const winter = await repository.availabilityAsOf(1, new Date("2026-12-14T00:00:00.000Z"));

    expect(summer!.availability[0].startTime.toISOString()).toBe(
      winter!.availability[0].startTime.toISOString()
    );
    expect(summer!.availability[0].startTime.getUTCHours()).toBe(9);
  });

  // Review Focus 4: buildDateRanges discriminates on `"date" in item && !!item.date`, so an
  // override must carry a real Date and an empty days array, exactly as Prisma would return it.
  it("maps an override row with an empty days array to a dated entry", async () => {
    const { client } = clientReturning({
      timeZone: "Europe/London",
      availability: [{ days: [], startTime: "13:00:00", endTime: "15:00:00", date: "2026-08-14" }],
    });
    const repository = new ScheduleVersionRepository(client as never);

    const snapshot = await repository.availabilityAsOf(1, new Date("2026-08-14T00:00:00.000Z"));

    const [override] = snapshot!.availability;
    expect(override.days).toEqual([]);
    expect(override.date?.toISOString()).toBe("2026-08-14T00:00:00.000Z");
    expect(override.startTime.getUTCHours()).toBe(13);
  });

  it("returns an empty availability array for a recorded empty schedule", async () => {
    const { client } = clientReturning({ timeZone: "Europe/London", availability: [] });
    const repository = new ScheduleVersionRepository(client as never);

    const snapshot = await repository.availabilityAsOf(1, new Date("2026-08-14T00:00:00.000Z"));

    expect(snapshot).not.toBeNull();
    expect(snapshot!.availability).toEqual([]);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `TZ=UTC yarn vitest run packages/features/schedules/repositories/ScheduleVersionRepository.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
yarn type-check:ci --force
yarn biome check --write <the files you changed>
git add packages/features/schedules/repositories/ScheduleVersionRepository.ts packages/features/schedules/repositories/ScheduleVersionRepository.test.ts
git commit -m "feat(availability): resolve recorded availability as of a past date

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Resolve past dates in listTeamAvailability

**Files:**
- Modify: `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.ts:103-145` (`buildMember`)
- Test: `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts` (extend the existing suite)

**Interfaces:**
- Consumes: `ScheduleVersionRepository` and `ScheduleVersionSnapshot` from Task 2.
- Produces: every member row gains `availabilitySource: "live" | "recorded" | "unrecorded"`, consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Append to `listTeamAvailability.handler.test.ts`. Note the existing file already mocks `UserRepository` and uses `prismaMock`; reuse both.

```ts
describe("listTeamAvailabilityHandler — past dates", () => {
  const PAST = { startDate: "2026-08-14T00:00:00.000Z", endDate: "2026-08-14T23:59:59.000Z" };

  const member = {
    id: 1,
    role: "MEMBER",
    user: {
      id: 11,
      name: "Aretha Hampton",
      username: "aretha",
      email: "aretha@example.com",
      timeZone: "Europe/London",
      defaultScheduleId: 99,
      travelSchedules: [],
      profile: null,
    },
  };

  beforeEach(() => {
    prismaMock.membership.findUnique.mockResolvedValue({ id: 1, role: "OWNER" });
    prismaMock.membership.count.mockResolvedValue(1);
    prismaMock.membership.findMany.mockResolvedValue([member]);
    prismaMock.platformOAuthClient.findUnique.mockResolvedValue({ organizationId: ORG_ID });
    prismaMock.schedule.findUnique.mockResolvedValue({
      timeZone: "Europe/London",
      availability: [
        { days: [1, 2, 3, 4, 5], startTime: new Date("1970-01-01T09:00:00.000Z"), endTime: new Date("1970-01-01T17:00:00.000Z"), date: null },
      ],
    });
  });

  // Review Focus 1: the motivating case. August predates capture, so there is no version —
  // and reporting today's live rows there is the exact bug this feature removes.
  it("reports unrecorded, not live rows, for a past date with no version", async () => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue(null);

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ ...PAST, oAuthClientId: CLIENT_ID }),
    });

    expect(result.rows[0].availabilitySource).toBe("unrecorded");
    expect(result.rows[0].dateRanges).toEqual([]);
    expect(prismaMock.schedule.findUnique).not.toHaveBeenCalled();
  });

  // Review Focus 2: a recorded empty schedule is a real answer and must not read as a gap.
  it("distinguishes a recorded empty schedule from an unrecorded date", async () => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue({ timeZone: "Europe/London", availability: [] });

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ ...PAST, oAuthClientId: CLIENT_ID }),
    });

    expect(result.rows[0].availabilitySource).toBe("recorded");
    expect(result.rows[0].dateRanges).toEqual([]);
  });

  it("reconstructs from the recorded version rather than the live schedule", async () => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue({
      timeZone: "Europe/London",
      availability: [{ days: [5], startTime: "14:00:00", endTime: "16:00:00", date: null }],
    });

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ ...PAST, oAuthClientId: CLIENT_ID }),
    });

    expect(result.rows[0].availabilitySource).toBe("recorded");
    expect(result.rows[0].dateRanges).not.toEqual([]);
    expect(prismaMock.schedule.findUnique).not.toHaveBeenCalled();
  });

  it("uses the timezone recorded at the time, not the current one", async () => {
    prismaMock.scheduleVersion.findFirst.mockResolvedValue({
      timeZone: "America/New_York",
      availability: [{ days: [5], startTime: "09:00:00", endTime: "17:00:00", date: null }],
    });

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({ ...PAST, oAuthClientId: CLIENT_ID }),
    });

    expect(result.rows[0].timeZone).toBe("America/New_York");
  });

  it("still reads live rows for today", async () => {
    const today = dayjs().startOf("day");

    const result = await listTeamAvailabilityHandler({
      ctx: { user: ctxUser() },
      input: input({
        startDate: today.toISOString(),
        endDate: today.endOf("day").toISOString(),
        oAuthClientId: CLIENT_ID,
      }),
    });

    expect(result.rows[0].availabilitySource).toBe("live");
    expect(prismaMock.scheduleVersion.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.schedule.findUnique).toHaveBeenCalled();
  });
});
```

Add `import dayjs from "@calcom/dayjs";` to the test file's imports if not already present.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`

Expected: FAIL — `availabilitySource` is undefined on every row.

- [ ] **Step 3: Add the resolver to the handler**

In `listTeamAvailability.handler.ts`, add these imports beside the existing ones:

```ts
import { ScheduleVersionRepository } from "@calcom/features/schedules/repositories/ScheduleVersionRepository";
import type { ScheduleVersionAvailability } from "@calcom/features/schedules/repositories/ScheduleVersionRepository";
import type { Availability } from "@calcom/prisma/client";
```

`Availability` is not currently imported — the handler relies on inference from the Prisma call — but the
`ResolvedAvailability` annotation below names it explicitly. `DateRange` and `Dayjs` are already imported.

Add this function immediately above `buildMember`:

```ts
type AvailabilitySource = "live" | "recorded" | "unrecorded";

type ResolvedAvailability = {
  availability: Availability[] | ScheduleVersionAvailability[];
  timeZone: string | null;
  source: AvailabilitySource;
};

async function resolveAvailability(
  defaultScheduleId: number,
  dateFrom: Dayjs
): Promise<ResolvedAvailability | null> {
  if (!dateFrom.isBefore(dayjs().startOf("day"))) {
    const schedule = await prisma.schedule.findUnique({
      where: { id: defaultScheduleId },
      select: { availability: true, timeZone: true },
    });
    return { availability: schedule?.availability ?? [], timeZone: schedule?.timeZone ?? null, source: "live" };
  }

  const recorded = await new ScheduleVersionRepository(prisma).availabilityAsOf(
    defaultScheduleId,
    dateFrom.toDate()
  );

  // No version covers this date, so it predates capture. Falling back to the live rows here
  // would answer a question about the past with today's data — the failure this exists to fix.
  if (!recorded) {
    return null;
  }

  return { availability: recorded.availability, timeZone: recorded.timeZone, source: "recorded" };
}
```

- [ ] **Step 4: Rewrite the body of buildMember**

Replace `listTeamAvailability.handler.ts:117-136` — from `const schedule = await prisma.schedule.findUnique({` through the closing `});` of the `buildDateRanges` call — with:

```ts
  const resolved = await resolveAvailability(member.user.defaultScheduleId, dateFrom);
  const timeZone = resolved?.timeZone || member.user.timeZone;

  const dateRanges = resolved
    ? buildDateRanges({
        dateFrom,
        dateTo,
        timeZone,
        availability: resolved.availability,
        travelSchedules: member.user.travelSchedules.map((schedule) => {
          return {
            startDate: dayjs(schedule.startDate),
            endDate: schedule.endDate ? dayjs(schedule.endDate) : undefined,
            timeZone: schedule.timeZone,
          };
        }),
      }).dateRanges
    : ([] as DateRange[]);
```

Then add `availabilitySource: resolved?.source ?? "unrecorded",` to the object returned at the end of `buildMember`, and to the early-return object for members with no `defaultScheduleId` (use `"live"` there — no schedule is a present-tense fact, not a gap in history).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`

Expected: PASS — the five new tests plus the existing suite from #5.

- [ ] **Step 6: Confirm the travelSchedules assumption**

The spec flags this. Run:

```bash
yarn prisma studio  # or a direct query
```

Or simply:
```bash
rg "travelSchedule" --type ts packages/features packages/trpc apps/api/v2 -l
```

Determine whether managed users can have `travelSchedules` at all. If they can, `travelSchedules` is unversioned and reconstruction is incomplete — record that in `agents/lavela-health-integration.md` §6 in Task 5 rather than silently leaving it. If they cannot, note that too.

- [ ] **Step 7: Commit**

```bash
yarn type-check:ci --force
yarn biome check --write <the files you changed>
git add packages/trpc/server/routers/viewer/availability/team/
git commit -m "feat(availability): resolve past dates from recorded history in listTeam

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Tell the truth in the fleet view

**Files:**
- Modify: `apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx`
- Modify: `packages/i18n/locales/en/common.json`

**Interfaces:**
- Consumes: `availabilitySource` on each member row, from Task 3.
- Produces: nothing downstream.

- [ ] **Step 1: Add the translation strings**

In `packages/i18n/locales/en/common.json`, add these keys (keep the file's existing alphabetical-ish grouping; place them near other `availability_` keys):

```json
"availability_recorded_history": "Recorded history",
"availability_recorded_history_description": "Showing availability as recorded on this date, not a projection.",
"availability_no_recorded_history": "No recorded history",
"availability_no_recorded_history_description": "Availability was not being recorded on this date.",
"availability_jump_to_date": "Jump to date",
```

- [ ] **Step 2: Extend SliderUser and read the flag**

In `AvailabilitySliderTable.tsx`, add to the `SliderUser` interface (after `dateRanges`):

```ts
  availabilitySource: "live" | "recorded" | "unrecorded";
```

Add below the `browsingDate` state declaration:

```ts
const isPastDate = browsingDate.isBefore(dayjs(), "day");
```

- [ ] **Step 3: Blank the nextAvailable column for past dates**

`nextAvailable` is fed by a separate `nextSlots` query about the *future*; beside a historical dial it is nonsense. In the `nextAvailable` column's `cell`, insert at the very top of the function body:

```ts
          if (isPastDate) {
            return <span className="text-subtle text-sm">&mdash;</span>;
          }
```

Change the column's `header` from `t("next_available")` to:

```ts
        header: isPastDate ? "" : t("next_available"),
```

Add `isPastDate` to the `useMemo` dependency array at the end of the columns memo, which currently reads `[browsingDate, t, nextSlots, isNextSlotsPending]`.

- [ ] **Step 4: Render the history marker in the slider cell**

Replace the `slider` column's `cell` with:

```ts
        cell: ({ row }) => {
          const { timeZone, dateRanges, availabilitySource } = row.original;

          if (availabilitySource === "unrecorded") {
            return (
              <span className="text-subtle text-sm" title={t("availability_no_recorded_history_description")}>
                {t("availability_no_recorded_history")}
              </span>
            );
          }

          return <TimeDial timezone={timeZone} dateRanges={dateRanges} />;
        },
```

- [ ] **Step 5: Add the date picker and the history badge to the slider header**

Replace the `slider` column's `header` with:

```ts
        header: () => {
          return (
            <div className="flex items-center space-x-2">
              <ButtonGroup containerProps={{ className: "space-x-0" }}>
                <Button
                  color="minimal"
                  variant="icon"
                  StartIcon="chevron-left"
                  onClick={() => setBrowsingDate(browsingDate.subtract(1, "day"))}
                />
                <Button
                  onClick={() => setBrowsingDate(browsingDate.add(1, "day"))}
                  color="minimal"
                  StartIcon="chevron-right"
                  variant="icon"
                />
              </ButtonGroup>
              <span>{browsingDate.format("LL")}</span>
              {/* Stepping back to August a day at a time is roughly 40 clicks. */}
              <DatePicker
                date={browsingDate.toDate()}
                onDatesChange={(date) => setBrowsingDate(dayjs(date))}
                minDate={HISTORY_BROWSING_FLOOR}
                label={t("availability_jump_to_date")}
                className="w-auto"
              />
              {isPastDate && (
                <Badge variant="orange" title={t("availability_recorded_history_description")}>
                  {t("availability_recorded_history")}
                </Badge>
              )}
            </div>
          );
        },
```

Add these imports at the top of the file:

```ts
import { Badge } from "@calcom/ui/components/badge";
import DatePicker from "@calcom/ui/components/form/datepicker/DatePicker";
```

And this constant above `AvailabilitySliderTableContent`:

```ts
// DatePicker defaults its floor to today, which would make every historical date unreachable.
const HISTORY_BROWSING_FLOOR = new Date("2026-01-01T00:00:00.000Z");
```

Verify the `Badge` import path and its accepted `variant` values before committing:
```bash
ls packages/ui/components/badge/
rg "variant" packages/ui/components/badge/Badge.tsx | head
```
If `orange` is not a valid variant, use the closest warning-toned one that is.

- [ ] **Step 6: Verify it renders**

Run the app and check `/availability`: step back to a past date and confirm the `next available` column is blank, the `Recorded history` badge appears, providers with no recorded version show "No recorded history" instead of an empty dial, and the date picker jumps directly to a date.

If a quick manual check is not practical, at minimum run `yarn type-check:ci --force` and confirm the file compiles.

- [ ] **Step 7: Commit**

```bash
yarn biome check --write <the files you changed>
yarn type-check:ci --force
git add apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx packages/i18n/locales/en/common.json
git commit -m "feat(availability): mark past dates as recorded history in the fleet view

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Update the Lavela integration contract

**Files:**
- Modify: `agents/lavela-health-integration.md` (§6 Availability and out-of-office, §11 Invariants)

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1-4.
- Produces: nothing in code.

This is required by CLAUDE.md in the same PR as the change. The doc is the only record of these couplings, so landing without it silently makes it wrong.

- [ ] **Step 1: Read the current sections**

```bash
sed -n "$(grep -n '^## 6\.' agents/lavela-health-integration.md | cut -d: -f1),$(grep -n '^## 7\.' agents/lavela-health-integration.md | cut -d: -f1)p" agents/lavela-health-integration.md
sed -n "$(grep -n '^## 11\.' agents/lavela-health-integration.md | cut -d: -f1),$(grep -n '^## 12\.' agents/lavela-health-integration.md | cut -d: -f1)p" agents/lavela-health-integration.md
```

- [ ] **Step 2: Extend §6**

Add a subsection recording, in the doc's existing voice:

- Every write to a schedule's availability or timezone is snapshotted into `ScheduleVersion` by a deferred Postgres trigger, so history survives the atom's destructive `deleteMany` + `createMany`.
- `listTeamAvailability` answers past dates from that history, and returns `availabilitySource: "live" | "recorded" | "unrecorded"` per member. `unrecorded` means no record exists for that date — it is **not** the same as zero availability.
- Capture starts at the migration's rollout. Dates before it, including August 2026, are `unrecorded` and unrecoverable.
- Reconstruction covers the weekly schedule plus overrides — *scheduled* availability. It does not subtract connected-calendar busy time or apply `minimumBookingNotice`, so it is not *offered* availability. Any occupancy report built on it must say so.
- Whatever Task 3 Step 6 established about `travelSchedules` — state it either way.
- §6's existing claims (lavela-health keeps no local mirror; the OOO override merge) remain true and stay.

- [ ] **Step 3: Add the invariant to §11**

Add, matching the numbering and phrasing of the existing invariants:

> Availability writes are versioned. Any path that writes `Availability` or `Schedule.timeZone` — the atom's tRPC path, the REST `PATCH /v2/schedules`, the create/duplicate handlers, ops scripts, raw SQL — is captured by the deferred `ScheduleVersion` triggers. Nothing may bypass them, and no code may delete from `ScheduleVersion`.

- [ ] **Step 4: Commit**

```bash
git add agents/lavela-health-integration.md
git commit -m "docs(availability): record history capture in the Lavela contract

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Verify the whole branch and open the PR

**Files:** none — verification only.

- [ ] **Step 1: Full type check**

Run: `yarn type-check:ci --force`
Expected: no new errors relative to `main`. If errors appear in files you did not touch, compare against `main` per `agents/rules/ci-type-check-first.md` before concluding they are yours.

- [ ] **Step 2: Unit tests**

Run: `TZ=UTC yarn test`
Expected: PASS.

- [ ] **Step 3: Integration tests**

Run: `VITEST_MODE=integration TZ=UTC yarn test`
Expected: PASS, including the 8 new trigger tests.

- [ ] **Step 4: Lint**

Run `yarn biome check --write <the files this branch changed>` — get the list with
`git diff --name-only $(git merge-base main HEAD)..HEAD`. Never pass `.`; it rewrites the
whole monorepo. Then re-run the type check if Biome changed anything.

- [ ] **Step 5: Confirm the REST path is unchanged**

The trigger only reads; it must not change which rows the REST repository deletes. `Cal::BlockOutOfOffice` sends only `overrides` and depends on weekly rules surviving. Confirm the partial-write test from Task 1 covers this, and if it does not, add:

```ts
  it("leaves weekly rules intact when only overrides are replaced", async () => {
    await prisma.availability.create({ data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId } });
    await prisma.availability.deleteMany({ where: { scheduleId, NOT: { date: null } } });
    await prisma.availability.create({
      data: {
        days: [],
        date: new Date("2026-10-01T00:00:00.000Z"),
        startTime: new Date("1970-01-01T13:00:00.000Z"),
        endTime: new Date("1970-01-01T15:00:00.000Z"),
        scheduleId,
        userId,
      },
    });

    const latest = (await versions()).at(-1);
    expect(latest?.availability).toEqual([
      { days: [1], startTime: "09:00:00", endTime: "17:00:00", date: null },
      { days: [], startTime: "13:00:00", endTime: "15:00:00", date: "2026-10-01" },
    ]);
  });
```

- [ ] **Step 6: Push and open the draft PR**

```bash
git push -u origin feat/availability-history
```

Open as a **draft** PR titled:

`feat(availability): persist history of availability and overrides`

Body must cover: what changed and why (the atom's destructive save destroys history); that capture starts at rollout and August is unrecoverable; the `unrecorded` vs empty distinction; that this is deliberately one PR rather than three, exceeding CLAUDE.md's size guidance at Lucas's direction; and a link to the Asana ticket and to `docs/superpowers/specs/2026-09-25-availability-history-design.md`.

End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
