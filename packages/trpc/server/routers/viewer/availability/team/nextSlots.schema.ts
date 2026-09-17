import { z } from "zod";

export const ZNextSlotsInputSchema = z.object({
  oAuthClientId: z.string(),
  userIds: z.array(z.number().int()).min(1).max(50),
  maxHorizonDays: z.number().int().min(1).max(365).optional(),
});

export type TNextSlotsInputSchema = z.infer<typeof ZNextSlotsInputSchema>;
