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
});
