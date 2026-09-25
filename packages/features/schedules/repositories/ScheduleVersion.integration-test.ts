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
    expect(rows.filter((row) => row.validTo === null)).toHaveLength(1);
  });

  it("records a baseline version when a schedule is created empty", async () => {
    const rows = await versions();
    expect(rows).toHaveLength(1);
    expect(rows[0].availability).toEqual([]);
    expect(rows[0].validTo).toBeNull();
  });

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
});
