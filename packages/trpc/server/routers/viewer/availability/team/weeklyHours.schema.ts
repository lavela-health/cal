import { z } from "zod";

export const ZWeeklyHoursInputSchema = z.object({
  oAuthClientId: z.string(),
  userIds: z.array(z.number().int()).min(1).max(50),
  /** The week's first day as YYYY-MM-DD. The client decides what a week starts on. */
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Decides whether the week has already passed, from the caller's day rather than the server's. */
  loggedInUsersTz: z.string(),
});

export type TWeeklyHoursInputSchema = z.infer<typeof ZWeeklyHoursInputSchema>;
