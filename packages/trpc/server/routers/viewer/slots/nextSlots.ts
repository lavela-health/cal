import type { IGetAvailableSlots } from "@calcom/features/bookings/Booker/hooks/useAvailableTimeSlots";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { GetScheduleOptions } from "./types";

const log = logger.getSubLogger({ prefix: ["[slots/nextSlots]"] });

export const NEXT_SLOTS_WINDOWS_DAYS = [7, 30, 90];
export const NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS = 90;
export const NEXT_SLOTS_DEFAULT_CONCURRENCY = 8;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

export type NextSlotUser = {
  id: number;
  username: string | null;
  name: string | null;
};

export type NextSlotCandidate = {
  eventTypeId: number;
  eventTypeSlug: string;
  /** Minutes. The event type's length, or the caller's explicit override. */
  duration: number;
  user?: NextSlotUser;
};

export type NextSlot = {
  start: string;
  end: string;
  duration: number;
  eventTypeId: number;
  eventTypeSlug: string;
  user?: NextSlotUser;
};

export interface ISlotsProvider {
  getAvailableSlots(args: GetScheduleOptions): Promise<IGetAvailableSlots>;
}

export type GetNextSlotsParams = {
  candidates: NextSlotCandidate[];
  limit: number;
  after?: Date;
  maxHorizonDays?: number;
  timeZone?: string;
};

export type GetNextSlotPerCandidateParams = Omit<GetNextSlotsParams, "limit">;

/**
 * The windows to try, in order, clamped to the caller's horizon. The last entry is always
 * exactly `maxHorizonDays` so the final attempt covers the whole permitted range.
 */
export function buildWindows(maxHorizonDays: number): number[] {
  const windows = NEXT_SLOTS_WINDOWS_DAYS.filter((days) => days < maxHorizonDays);
  return [...windows, maxHorizonDays];
}

export class NextSlotsService {
  constructor(
    private readonly slotsProvider: ISlotsProvider,
    private readonly concurrency: number = NEXT_SLOTS_DEFAULT_CONCURRENCY
  ) {}

  /**
   * The `limit` soonest slots across every candidate.
   *
   * Widening stops as soon as a window yields `limit` slots: every slot outside the window
   * starts later than every slot inside it, so a full window is already the global answer.
   */
  async getNextSlots({
    candidates,
    limit,
    after: requestedAfter = new Date(),
    maxHorizonDays = NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS,
    timeZone,
  }: GetNextSlotsParams): Promise<NextSlot[]> {
    if (!candidates.length || limit < 1) return [];

    // A caller-supplied `after` in the past would spend the whole first window on days
    // that have already happened, and `getStartTime` clamps the query to now regardless.
    const now = new Date();
    const after = requestedAfter.getTime() < now.getTime() ? now : requestedAfter;

    let found: NextSlot[] = [];
    for (const windowDays of buildWindows(maxHorizonDays)) {
      const batches = await this.mapWithConcurrency(candidates, (candidate) =>
        this.slotsForCandidate({ candidate, after, windowDays, timeZone })
      );
      const windowSlots = sortSlots(batches.flat()).slice(0, limit);
      // Never regress on a widening. A wider window is normally a superset, but a
      // candidate whose calendar times out on the second pass would otherwise erase the
      // slots the first pass already found for it.
      if (windowSlots.length > found.length) found = windowSlots;
      if (found.length >= limit) break;
    }
    return found;
  }

  /** The soonest slot for each candidate, or null when the horizon holds none. */
  async getNextSlotPerCandidate({
    candidates,
    after = new Date(),
    maxHorizonDays = NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS,
    timeZone,
  }: GetNextSlotPerCandidateParams): Promise<Map<number, NextSlot | null>> {
    const results = await this.mapWithConcurrency(candidates, async (candidate) => {
      const [slot] = await this.getNextSlots({
        candidates: [candidate],
        limit: 1,
        after,
        maxHorizonDays,
        timeZone,
      });
      return [candidate.eventTypeId, slot ?? null] as const;
    });
    return new Map(results);
  }

  private async slotsForCandidate({
    candidate,
    after,
    windowDays,
    timeZone,
  }: {
    candidate: NextSlotCandidate;
    after: Date;
    windowDays: number;
    timeZone?: string;
  }): Promise<NextSlot[]> {
    // Day-aligned bounds keep the `withSlotsCache` key stable across calls made seconds
    // apart; slots before `after` are filtered out below rather than by the query.
    const startOfDay = new Date(Math.floor(after.getTime() / MS_PER_DAY) * MS_PER_DAY);
    const endOfWindow = new Date(startOfDay.getTime() + windowDays * MS_PER_DAY - 1);

    let available: IGetAvailableSlots;
    try {
      available = await this.slotsProvider.getAvailableSlots({
        ctx: {},
        input: {
          eventTypeId: candidate.eventTypeId,
          startTime: startOfDay.toISOString(),
          endTime: endOfWindow.toISOString(),
          duration: candidate.duration,
          timeZone,
          isTeamEvent: false,
          orgSlug: null,
        },
      });
    } catch (error) {
      // One provider's calendar being unreachable must not empty the whole board.
      log.warn(
        "Skipping candidate whose slots could not be computed",
        safeStringify({ eventTypeId: candidate.eventTypeId, error })
      );
      return [];
    }

    return Object.values(available.slots)
      .flat()
      .filter((slot) => !slot.away)
      .map((slot) => toNextSlot(slot.time, candidate))
      .filter((slot) => new Date(slot.start).getTime() > after.getTime());
  }

  private async mapWithConcurrency<TItem, TResult>(
    items: TItem[],
    worker: (item: TItem) => Promise<TResult>
  ): Promise<TResult[]> {
    const results = new Array<TResult>(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]);
      }
    });

    await Promise.all(runners);
    return results;
  }
}

function toNextSlot(time: string, candidate: NextSlotCandidate): NextSlot {
  const start = new Date(time);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + candidate.duration * MS_PER_MINUTE).toISOString(),
    duration: candidate.duration,
    eventTypeId: candidate.eventTypeId,
    eventTypeSlug: candidate.eventTypeSlug,
    ...(candidate.user ? { user: candidate.user } : {}),
  };
}

function sortSlots(slots: NextSlot[]): NextSlot[] {
  return [...slots].sort((a, b) => {
    const delta = new Date(a.start).getTime() - new Date(b.start).getTime();
    // Stable across calls: without the tie-break, two providers free at the same instant
    // swap places between requests depending on which fan-out resolved first.
    return delta !== 0 ? delta : a.eventTypeId - b.eventTypeId;
  });
}
