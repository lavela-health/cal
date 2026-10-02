type Translate = (key: string, vars?: Record<string, unknown>) => string;

const MINUTES_PER_HOUR = 60;

/** Renders a minute count as hours, keeping the remainder: a 50-minute session rarely divides evenly. */
export function formatMinutesAsHours(minutes: number, t: Translate): string {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const remainder = minutes % MINUTES_PER_HOUR;

  if (hours === 0 && remainder > 0) {
    return t("duration_minutes", { minutes: remainder });
  }

  if (remainder === 0) {
    return t("duration_hours", { hours });
  }

  return t("duration_hours_minutes", { hours, minutes: remainder });
}
