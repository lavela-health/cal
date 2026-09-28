-- CreateTable
CREATE TABLE "public"."ScheduleVersion" (
    "id" SERIAL NOT NULL,
    "scheduleId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "timeZone" TEXT,
    "availability" JSONB NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "txId" BIGINT NOT NULL,

    CONSTRAINT "ScheduleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleVersion_scheduleId_validFrom_idx" ON "public"."ScheduleVersion"("scheduleId", "validFrom");

-- CreateIndex
CREATE INDEX "ScheduleVersion_userId_validFrom_idx" ON "public"."ScheduleVersion"("userId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleVersion_scheduleId_txId_key" ON "public"."ScheduleVersion"("scheduleId", "txId");

-- Shared by capture_schedule_version (per-row trigger capture) and the seed below, so the
-- snapshot shape can never drift between live capture and the initial backfill.
CREATE OR REPLACE FUNCTION schedule_availability_snapshot(p_schedule_id INTEGER)
RETURNS JSONB AS $$
  -- The ORDER BY is load-bearing, not cosmetic: jsonb_agg is otherwise free to return rows
  -- in any order, which would make the equality check in capture_schedule_version fire
  -- spuriously.
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
  FROM "Availability" a
  WHERE a."scheduleId" = p_schedule_id;
$$ LANGUAGE sql STABLE;

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
  v_now        TIMESTAMP;
  v_current_txid BIGINT;
  v_has_open   BOOLEAN;
BEGIN
  -- Serialise capture per schedule. Without this, two transactions committing against the
  -- same schedule each close the version they can see and each insert an open one, leaving
  -- two rows with validTo IS NULL and an ambiguous reconstruction.
  PERFORM pg_advisory_xact_lock(hashtext('ScheduleVersion'), p_schedule_id);

  -- CURRENT_TIMESTAMP is fixed at transaction start, not at the moment this deferred
  -- trigger actually runs at COMMIT, so it does not follow lock-serialised capture order:
  -- a transaction that started later but committed (and so captured) first would get an
  -- earlier stamp than one still waiting on the lock, producing validTo < validFrom.
  -- clock_timestamp() taken right after acquiring the lock is monotonic in capture order,
  -- and using the same value for both the closed row's validTo and the new row's validFrom
  -- preserves the no-gap/no-overlap chain.
  --
  -- AT TIME ZONE 'UTC' is load-bearing: clock_timestamp() is a timestamptz, and assigning one
  -- into a `timestamp without time zone` converts through the session's TimeZone GUC, which is
  -- whatever the server happens to be set to. Prisma reads the column back as UTC regardless,
  -- so on any non-UTC server every stamp would be silently offset from the instants
  -- availabilityAsOf() compares against, and resolution near a day boundary would pick the
  -- wrong version.
  v_now := (clock_timestamp() AT TIME ZONE 'UTC');

  SELECT s."userId", s."timeZone" INTO v_user_id, v_time_zone
  FROM "Schedule" s
  WHERE s.id = p_schedule_id;

  -- The schedule itself was deleted in this transaction; closing its history is the
  -- delete trigger's job, not ours.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Read the open version before building the snapshot, so a repeat firing can be answered
  -- from this indexed lookup alone. This ordering is what keeps capture linear: the trigger is
  -- FOR EACH ROW (CONSTRAINT triggers cannot be anything else), so the atom's deleteMany +
  -- createMany fires this function once per deleted row and once per inserted row, and
  -- rebuilding the full snapshot on each of those firings made a save cost O(n^2) in the
  -- schedule's availability rows -- measured at ~1s inside COMMIT for a 400-row schedule
  -- against ~70ms for 100 rows, while holding the advisory lock above.
  SELECT sv.availability, sv."timeZone", sv."txId" INTO v_current, v_current_tz, v_current_txid
  FROM "ScheduleVersion" sv
  WHERE sv."scheduleId" = p_schedule_id
    AND sv."validTo" IS NULL
  ORDER BY sv."validFrom" DESC
  LIMIT 1;
  v_has_open := FOUND;

  -- This transaction has already settled this schedule, either by inserting the version below
  -- or by confirming the open one still matches. Every deferred firing sees the same final
  -- state -- the premise this whole design rests on -- so there is nothing left to decide.
  IF v_has_open AND v_current_txid = v_txid THEN
    RETURN;
  END IF;

  v_snapshot := schedule_availability_snapshot(p_schedule_id);

  -- Nothing changed. A name-only save, or a second firing of this same trigger, must not
  -- manufacture a version.
  IF v_has_open
     AND v_current = v_snapshot
     AND v_current_tz IS NOT DISTINCT FROM v_time_zone THEN
    -- Stamp the surviving version with this transaction so the remaining firings take the
    -- early return above instead of rebuilding the snapshot. Recording which transaction last
    -- confirmed a version is what txId is for -- collapsing this trigger's repeated per-row
    -- firings into one decision -- and nothing outside this function reads the column.
    UPDATE "ScheduleVersion"
       SET "txId" = v_txid
     WHERE "scheduleId" = p_schedule_id
       AND "validTo" IS NULL;
    RETURN;
  END IF;

  UPDATE "ScheduleVersion"
     SET "validTo" = v_now
   WHERE "scheduleId" = p_schedule_id
     AND "validTo" IS NULL
     AND "txId" <> v_txid;

  INSERT INTO "ScheduleVersion" ("scheduleId", "userId", "timeZone", "availability", "validFrom", "txId")
  VALUES (p_schedule_id, v_user_id, v_time_zone, v_snapshot, v_now, v_txid)
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
DECLARE
  v_now TIMESTAMP;
BEGIN
  -- The same per-schedule lock capture_schedule_version takes, and for a related reason.
  -- Without it, a capture committing concurrently against this schedule can close the old open
  -- version and insert a new one while this UPDATE is blocked on the old row; when it unblocks,
  -- READ COMMITTED re-checks only the row it already found, not the one inserted since, so the
  -- new open version survives the delete and reads as "still in effect" for every future date.
  PERFORM pg_advisory_xact_lock(hashtext('ScheduleVersion'), OLD.id);

  -- clock_timestamp(), not CURRENT_TIMESTAMP, for exactly the reason spelled out in
  -- capture_schedule_version: CURRENT_TIMESTAMP is fixed at transaction start, not at the
  -- moment this deferred trigger runs at COMMIT. A transaction that began before a concurrent
  -- capture but commits after it would otherwise close that capture's version with a stamp
  -- predating its own validFrom, and availabilityAsOf() can never select an interval whose
  -- validTo precedes its validFrom -- the schedule's final recorded state would silently read
  -- as unrecorded. Taking the stamp after the lock keeps it monotonic in capture order.
  --
  -- AT TIME ZONE 'UTC' is load-bearing for the same reason as well: the column is
  -- `timestamp without time zone` and Prisma reads it back as UTC.
  v_now := (clock_timestamp() AT TIME ZONE 'UTC');

  UPDATE "ScheduleVersion"
     SET "validTo" = v_now
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

-- Seed one version per existing schedule, using the same snapshot builder capture_schedule_version
-- uses, so the seeded rows cannot drift from live capture. This INSERT ... SELECT is deliberately
-- lock-free: the table was just created, nothing else can be writing to it yet, so there is no
-- concurrent capture to serialise against. Taking the per-schedule advisory lock here as well
-- would mean holding one lock per schedule for the rest of this migration transaction, which risks
-- exhausting the shared lock table on large installs.
INSERT INTO "ScheduleVersion" ("scheduleId", "userId", "timeZone", "availability", "validFrom", "txId")
SELECT s.id, s."userId", s."timeZone", schedule_availability_snapshot(s.id),
       (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), txid_current()
FROM "Schedule" s;

-- Reconciliation: capture_schedule_version fails quietly by design (see its EXCEPTION block
-- above), trading a missing version row for never blocking a provider's schedule save. These two
-- queries are the signals that reveal a silent gap, for ad-hoc use, not automated alerting:
--
--   -- A version closed before it opened - should be unreachable now that both writers of
--   -- validTo (capture_schedule_version and close_schedule_version) stamp with
--   -- clock_timestamp() under the per-schedule advisory lock rather than CURRENT_TIMESTAMP;
--   -- a hit here means one of the two regressed.
--   SELECT * FROM "ScheduleVersion" WHERE "validTo" IS NOT NULL AND "validTo" < "validFrom";
--
--   -- More than one open version for a schedule - a capture failed to close its predecessor.
--   SELECT "scheduleId", COUNT(*) FROM "ScheduleVersion" WHERE "validTo" IS NULL GROUP BY "scheduleId" HAVING COUNT(*) > 1;
