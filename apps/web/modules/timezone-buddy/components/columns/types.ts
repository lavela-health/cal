import type { DateRange } from "@calcom/features/schedules/lib/date-ranges";
import type { MembershipRole } from "@calcom/prisma/enums";
import type { UserProfile } from "@calcom/types/UserProfile";

export interface SliderUser {
  id: number;
  username: string | null;
  name: string | null;
  organizationId: number;
  avatarUrl: string | null;
  email: string;
  timeZone: string;
  role: MembershipRole;
  defaultScheduleId: number | null;
  dateRanges: DateRange[];
  availabilitySource: "live" | "recorded" | "unrecorded";
  profile: UserProfile;
}
