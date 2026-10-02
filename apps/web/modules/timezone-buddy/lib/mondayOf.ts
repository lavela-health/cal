import type { Dayjs } from "@calcom/dayjs";

const DAYS_FROM_MONDAY = 6;

/**
 * The Monday that starts the week containing `date`.
 *
 * Done by hand rather than with `startOf("week")`, which is locale-dependent and would start
 * the week on Sunday here, and rather than with the isoWeek plugin, which `@calcom/dayjs` does
 * not load.
 */
export function mondayOf(date: Dayjs): Dayjs {
  return date.subtract((date.day() + DAYS_FROM_MONDAY) % 7, "day").startOf("day");
}
