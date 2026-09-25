import prisma from "@calcom/prisma";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const uniqueEmail = () => `schedule-version-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

// Lets two concurrent operations rendezvous before either is allowed to proceed, so a
// concurrency test can force real overlap instead of hoping two promises race.
const defer = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

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
    // Availability before Schedule before ScheduleVersion: deleting availability fires capture
    // and inserts a fresh open version, and deleting the schedule is what closes it. Deleting
    // ScheduleVersion rows before that leaves the version capture creates behind, orphaned,
    // with nothing to reap it. Filtered by userId, not scheduleId, so it also covers schedules
    // created ad hoc inside a test (e.g. a reassignment target).
    await prisma.availability.deleteMany({ where: { userId } });
    await prisma.schedule.deleteMany({ where: { userId } });
    await prisma.scheduleVersion.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const versionsFor = (id: number) =>
    prisma.scheduleVersion.findMany({
      where: { scheduleId: id },
      orderBy: { validFrom: "asc" },
      select: { id: true, availability: true, timeZone: true, validFrom: true, validTo: true },
    });

  const versions = () => versionsFor(scheduleId);

  const weekly = (days: number[], start: string, end: string) => ({
    days,
    startTime: new Date(`1970-01-01T${start}:00.000Z`),
    endTime: new Date(`1970-01-01T${end}:00.000Z`),
  });

  // Pins the ordering guarantee capture_schedule_version depends on: clock_timestamp(), taken
  // after the advisory lock, must never let a closed version's validTo land before its own
  // validFrom, and at most one version may be open for a schedule at a time.
  const assertNoInvertedOrDuplicateOpenVersions = (
    rows: Array<{ validFrom: Date; validTo: Date | null }>
  ) => {
    for (const row of rows) {
      if (row.validTo) {
        expect(row.validTo.getTime()).toBeGreaterThanOrEqual(row.validFrom.getTime());
      }
    }
    expect(rows.filter((row) => row.validTo === null).length).toBeLessThanOrEqual(1);
  };

  // Every other assertion in this file compares validFrom/validTo against each other, so a
  // stamp written in the wrong timezone is invisible to all of them. This is the one that
  // compares against an absolute instant observed from the JS side: the trigger stores a
  // `timestamp without time zone` and Prisma reads it back as UTC, so anything but a UTC wall
  // clock silently offsets every version by the server's UTC offset and makes resolution near
  // a day boundary pick the wrong version.
  const CLOCK_TOLERANCE_MS = 5_000;

  it("stamps validFrom with the UTC instant the capture actually happened", async () => {
    const before = Date.now();

    await prisma.availability.create({
      data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId },
      select: { id: true },
    });

    const after = Date.now();
    const latest = (await versions()).at(-1);

    expect(latest?.validFrom.getTime()).toBeGreaterThanOrEqual(before - CLOCK_TOLERANCE_MS);
    expect(latest?.validFrom.getTime()).toBeLessThanOrEqual(after + CLOCK_TOLERANCE_MS);
  });

  // close_schedule_version stamps validTo from its own expression rather than the captured
  // v_now, so it needs its own guard against the same timezone mistake.
  it("stamps validTo with the UTC instant a schedule was deleted", async () => {
    await prisma.availability.create({
      data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId },
      select: { id: true },
    });

    const before = Date.now();
    await prisma.schedule.delete({ where: { id: scheduleId } });
    const after = Date.now();

    const closed = (await versions()).at(-1);

    expect(closed?.validTo).not.toBeNull();
    expect(closed?.validTo?.getTime()).toBeGreaterThanOrEqual(before - CLOCK_TOLERANCE_MS);
    expect(closed?.validTo?.getTime()).toBeLessThanOrEqual(after + CLOCK_TOLERANCE_MS);
  });

  it("records exactly one new version for an atom-shaped deleteMany + createMany", async () => {
    // Creating the schedule in beforeEach already records a baseline version holding [],
    // because an empty schedule is a real state. Assert relative to that baseline.
    const before = await versions();

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
    expect(rows).toHaveLength(before.length + 1);
    expect(rows.at(-1)?.availability).toEqual([
      { days: [1, 2, 3], startTime: "09:00:00", endTime: "17:00:00", date: null },
      { days: [4], startTime: "10:00:00", endTime: "12:00:00", date: null },
    ]);
    expect(rows.at(-1)?.validTo).toBeNull();
    assertNoInvertedOrDuplicateOpenVersions(rows);
  });

  it("records a baseline version when a schedule is created empty", async () => {
    const rows = await versions();
    expect(rows).toHaveLength(1);
    expect(rows[0].availability).toEqual([]);
    expect(rows[0].validTo).toBeNull();
  });

  it("records a version when a schedule is emptied to nothing", async () => {
    await prisma.availability.create({
      data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId },
      select: { id: true },
    });
    const before = await versions();

    await prisma.availability.deleteMany({ where: { scheduleId } });

    const rows = await versions();
    expect(rows).toHaveLength(before.length + 1);
    expect(rows.at(-1)?.availability).toEqual([]);
    expect(rows.at(-1)?.validTo).toBeNull();
    expect(rows.at(-2)?.validTo).not.toBeNull();
    assertNoInvertedOrDuplicateOpenVersions(rows);
  });

  it("does not record a version when only the name changes", async () => {
    await prisma.availability.create({
      data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId },
      select: { id: true },
    });
    const before = await versions();

    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { name: "Renamed" },
      select: { id: true },
    });

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
      select: { id: true },
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

  it("leaves weekly rules intact when only overrides are replaced", async () => {
    await prisma.availability.create({
      data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId },
      select: { id: true },
    });

    // The REST path deletes only the category in the payload, keyed on `date IS NULL` —
    // unlike the atom, which wipes the schedule. Cal::BlockOutOfOffice depends on this.
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
      select: { id: true },
    });

    const latest = (await versions()).at(-1);
    expect(latest?.availability).toEqual([
      { days: [1], startTime: "09:00:00", endTime: "17:00:00", date: null },
      { days: [], startTime: "13:00:00", endTime: "15:00:00", date: "2026-10-01" },
    ]);
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
    assertNoInvertedOrDuplicateOpenVersions(rows);
    for (let i = 0; i < rows.length - 1; i++) {
      const validTo = rows[i].validTo;
      expect(validTo).not.toBeNull();
      if (!validTo) continue;
      expect(validTo.getTime()).toBeLessThanOrEqual(rows[i + 1].validFrom.getTime());
    }
  });

  it("closes the open version when a schedule is deleted", async () => {
    await prisma.availability.create({
      data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId },
      select: { id: true },
    });

    await prisma.schedule.delete({ where: { id: scheduleId } });

    const rows = await versions();
    expect(rows.every((row) => row.validTo !== null)).toBe(true);
    assertNoInvertedOrDuplicateOpenVersions(rows);
  });

  it("captures both schedules when an availability row is reassigned between them", async () => {
    const otherSchedule = await prisma.schedule.create({
      data: { userId, name: "Other Hours", timeZone: "Europe/London" },
      select: { id: true },
    });

    const availability = await prisma.availability.create({
      data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId },
      select: { id: true },
    });

    const beforeOrigin = await versions();
    const beforeOther = await versionsFor(otherSchedule.id);

    await prisma.availability.update({
      where: { id: availability.id },
      data: { scheduleId: otherSchedule.id },
      select: { id: true },
    });

    const afterOrigin = await versions();
    const afterOther = await versionsFor(otherSchedule.id);

    expect(afterOrigin).toHaveLength(beforeOrigin.length + 1);
    expect(afterOrigin.at(-1)?.availability).toEqual([]);

    expect(afterOther).toHaveLength(beforeOther.length + 1);
    expect(afterOther.at(-1)?.availability).toEqual([
      { days: [1], startTime: "09:00:00", endTime: "17:00:00", date: null },
    ]);

    assertNoInvertedOrDuplicateOpenVersions(afterOrigin);
    assertNoInvertedOrDuplicateOpenVersions(afterOther);
  });

  it("leaves exactly one open version when two transactions commit concurrently", async () => {
    // A plain Promise.all of two schedule.update calls does not prove the advisory lock in
    // capture_schedule_version does anything: with sub-millisecond non-interactive writes it
    // would pass even with the lock removed. This forces genuine overlap by holding both
    // transactions open — writes issued, deferred triggers armed but not yet fired — until
    // both are ready, so they contend for the advisory lock at COMMIT for real.
    const readyA = defer();
    const readyB = defer();

    const txA = prisma.$transaction(async (tx) => {
      await tx.schedule.update({
        where: { id: scheduleId },
        data: {
          availability: {
            deleteMany: { scheduleId: { equals: scheduleId } },
            createMany: { data: [weekly([1], "09:00", "17:00")] },
          },
        },
        select: { id: true },
      });
      readyA.resolve();
      await readyB.promise;
    });

    const txB = prisma.$transaction(async (tx) => {
      await tx.schedule.update({
        where: { id: scheduleId },
        data: {
          availability: {
            deleteMany: { scheduleId: { equals: scheduleId } },
            createMany: { data: [weekly([2], "10:00", "18:00")] },
          },
        },
        select: { id: true },
      });
      readyB.resolve();
      await readyA.promise;
    });

    await Promise.all([txA, txB]);

    const rows = await versions();
    assertNoInvertedOrDuplicateOpenVersions(rows);
    expect(rows.filter((row) => row.validTo === null)).toHaveLength(1);
  });

  it("never closes a version with a validTo before its own validFrom, when the transaction that began first commits last", async () => {
    // This is the scenario Important-1 identified: capture_schedule_version stamped validTo
    // and validFrom with CURRENT_TIMESTAMP, which is fixed at each transaction's own BEGIN, not
    // at the moment its deferred trigger actually runs at COMMIT. txA begins first (an earlier
    // BEGIN-time stamp) but is held open past txB's full commit, so when txA finally commits it
    // closes the version txB just opened — using a stamp that predates txB's own validFrom.
    // clock_timestamp(), taken after the advisory lock at the moment capture actually runs,
    // fixes this; this test fails on CURRENT_TIMESTAMP and passes with the fix.
    const insertedA = defer();
    const canCommitA = defer();

    const txA = prisma.$transaction(async (tx) => {
      await tx.availability.create({
        data: { ...weekly([1], "09:00", "17:00"), scheduleId, userId },
        select: { id: true },
      });
      insertedA.resolve();
      await canCommitA.promise;
    });

    await insertedA.promise;

    // Starts after txA's BEGIN, but is a standalone write that commits (and captures) in full
    // immediately, well before txA is released below.
    await prisma.availability.create({
      data: { ...weekly([2], "10:00", "18:00"), scheduleId, userId },
      select: { id: true },
    });

    canCommitA.resolve();
    await txA;

    const rows = await versions();
    assertNoInvertedOrDuplicateOpenVersions(rows);
    expect(rows.filter((row) => row.validTo === null)).toHaveLength(1);
  });
});
