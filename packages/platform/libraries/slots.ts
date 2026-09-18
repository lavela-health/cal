import { BusyTimesService } from "@calcom/features/busyTimes/services/getBusyTimes";
import { NoSlotsNotificationService } from "@calcom/features/slots/handleNotificationWhenNoSlots";
import {
  NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS,
  NextSlotsService,
} from "@calcom/trpc/server/routers/viewer/slots/nextSlots";
import { AvailableSlotsService } from "@calcom/trpc/server/routers/viewer/slots/util";

export type {
  ISlotsProvider,
  NextSlot,
  NextSlotCandidate,
  NextSlotsResult,
  NextSlotUser,
} from "@calcom/trpc/server/routers/viewer/slots/nextSlots";
export type { GetScheduleOptions } from "@calcom/trpc/server/routers/viewer/slots/types";

export { AvailableSlotsService };

export { NextSlotsService, NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS };

export { BusyTimesService };

export { NoSlotsNotificationService };

// Round-robin slot validation removed (EE feature) — stub for API v2
export async function validateRoundRobinSlotAvailability(
  _eventTypeId: number,
  _startDate: unknown,
  _endDate: unknown,
  _hosts: unknown[]
): Promise<boolean> {
  return true;
}
