import { SUCCESS_STATUS, X_CAL_SECRET_KEY } from "@calcom/platform-constants";
import type { NextSlotCandidate } from "@calcom/platform-libraries/slots";
import { GetClientNextSlotsInput_2024_09_04 } from "@calcom/platform-types";
import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse as DocsResponse, ApiTags as DocsTags } from "@nestjs/swagger";
import { API_VERSIONS_VALUES } from "@/lib/api-versions";
import { ApiAuthGuard } from "@/modules/auth/guards/api-auth/api-auth.guard";
import { OAuthClientGuard } from "@/modules/oauth-clients/guards/oauth-client-guard";
import { GetNextSlotsOutput_2024_09_04 } from "@/modules/slots/slots-2024-09-04/outputs/get-next-slots.output";
import { NextSlotsService_2024_09_04 } from "@/modules/slots/slots-2024-09-04/services/next-slots.service";
import { UsersRepository } from "@/modules/users/users.repository";

@Controller({
  path: "/v2/oauth-clients/:clientId/slots",
  version: API_VERSIONS_VALUES,
})
@UseGuards(ApiAuthGuard, OAuthClientGuard)
@DocsTags("Platform / Managed Users")
@ApiHeader({
  name: X_CAL_SECRET_KEY,
  description: "OAuth client secret key",
  required: true,
})
export class OAuthClientSlotsController {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly nextSlotsService: NextSlotsService_2024_09_04
  ) {}

  @Get("/next")
  @ApiOperation({
    summary: "Get the next available time slots across all managed users",
    description: `
      Returns the soonest available slots across every managed user of the OAuth client, as a flat, time-ordered array, each slot tagged with the user it is bookable with.

      By default every bookable event type each managed user owns is searched, so the returned slots can differ in duration — use 'eventTypeId' and 'duration' on each slot to tell them apart, or pass 'eventTypeSlug' to narrow the search.

      Managed users with no bookable event type are skipped. A response shorter than 'limit' means no further slots exist within 'maxHorizonDays'.
      `,
  })
  @DocsResponse({ status: 200, type: GetNextSlotsOutput_2024_09_04 })
  async getNextSlots(
    @Param("clientId") clientId: string,
    @Query() query: GetClientNextSlotsInput_2024_09_04
  ): Promise<GetNextSlotsOutput_2024_09_04> {
    const users = await this.usersRepository.findManagedUsersWithBookableEventTypes(
      clientId,
      query.eventTypeSlug
    );

    const candidates: NextSlotCandidate[] = users.flatMap((user) =>
      user.ownedEventTypes.map((eventType) => ({
        eventTypeId: eventType.id,
        eventTypeSlug: eventType.slug,
        duration: eventType.length,
        user: { id: user.id, username: user.username, name: user.name },
      }))
    );

    const slots = await this.nextSlotsService.getNextSlots({
      candidates,
      limit: query.limit,
      after: query.after,
      timeZone: query.timeZone,
      maxHorizonDays: query.maxHorizonDays,
    });

    return {
      data: slots,
      status: SUCCESS_STATUS,
    };
  }
}
