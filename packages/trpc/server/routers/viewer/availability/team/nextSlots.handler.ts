import { getAvailableSlotsService } from "@calcom/features/di/containers/AvailableSlots";
import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "../../../../types";
import { NextSlotsService, type NextSlotCandidate } from "../../slots/nextSlots";
import type { TNextSlotsInputSchema } from "./nextSlots.schema";
import { resolveOAuthClientOrganization } from "./resolveOAuthClientOrganization";

type GetOptions = {
  ctx: { user: NonNullable<TrpcSessionUser> };
  input: TNextSlotsInputSchema;
};

export type NextSlotForUser = {
  start: string;
  end: string;
  eventTypeId: number;
  eventTypeSlug: string;
  duration: number;
};

export const nextSlotsHandler = async ({ ctx, input }: GetOptions) => {
  // Throws FORBIDDEN unless the caller administers the organization owning the client.
  await resolveOAuthClientOrganization({
    userId: ctx.user.id,
    oAuthClientId: input.oAuthClientId,
  });

  // Scoping by the client as well as the ids keeps a caller from probing users outside it.
  const users = await prisma.user.findMany({
    where: {
      id: { in: input.userIds },
      platformOAuthClients: { some: { id: input.oAuthClientId } },
    },
    select: {
      id: true,
      ownedEventTypes: {
        where: { hidden: false },
        select: { id: true, slug: true, length: true },
      },
    },
  });

  const candidates: NextSlotCandidate[] = users.flatMap((user) =>
    user.ownedEventTypes.map((eventType) => ({
      eventTypeId: eventType.id,
      eventTypeSlug: eventType.slug,
      duration: eventType.length,
      user: { id: user.id, username: null, name: null },
    }))
  );

  const service = new NextSlotsService(getAvailableSlotsService());
  const byEventType = await service.getNextSlotPerCandidate({
    candidates,
    maxHorizonDays: input.maxHorizonDays,
  });

  const result: Record<string, NextSlotForUser | null> = {};
  for (const userId of input.userIds) {
    result[String(userId)] = null;
  }

  for (const candidate of candidates) {
    const slot = byEventType.get(candidate.eventTypeId);
    if (!slot || !candidate.user) continue;
    const key = String(candidate.user.id);
    const current = result[key];
    // A user can own several event types; the soonest of them is what the grid shows.
    if (current && new Date(current.start) <= new Date(slot.start)) continue;
    result[key] = {
      start: slot.start,
      end: slot.end,
      eventTypeId: slot.eventTypeId,
      eventTypeSlug: slot.eventTypeSlug,
      duration: slot.duration,
    };
  }

  return result;
};
