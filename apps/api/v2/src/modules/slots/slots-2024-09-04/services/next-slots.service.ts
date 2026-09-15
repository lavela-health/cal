import { type NextSlot, type NextSlotCandidate, NextSlotsService } from "@calcom/platform-libraries/slots";
import type { GetNextSlotsInput_2024_09_04 } from "@calcom/platform-types";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AvailableSlotsService } from "@/lib/services/available-slots.service";
import { UsersRepository } from "@/modules/users/users.repository";
import { EventTypesRepository_2024_06_14 } from "@/platform/event-types/event-types_2024_06_14/event-types.repository";

@Injectable()
export class NextSlotsService_2024_09_04 {
  private readonly engine: NextSlotsService;

  constructor(
    availableSlotsService: AvailableSlotsService,
    private readonly eventTypesRepository: EventTypesRepository_2024_06_14,
    private readonly usersRepository: UsersRepository
  ) {
    this.engine = new NextSlotsService(availableSlotsService);
  }

  async getNextSlotsForEventType(query: GetNextSlotsInput_2024_09_04): Promise<NextSlot[]> {
    const eventType = await this.resolveEventType(query);

    return this.getNextSlots({
      candidates: [
        {
          eventTypeId: eventType.id,
          eventTypeSlug: eventType.slug,
          duration: query.duration ?? eventType.length,
        },
      ],
      limit: query.limit,
      after: query.after,
      timeZone: query.timeZone,
      maxHorizonDays: query.maxHorizonDays,
    });
  }

  async getNextSlots({
    candidates,
    limit,
    after,
    timeZone,
    maxHorizonDays,
  }: {
    candidates: NextSlotCandidate[];
    limit: number;
    after?: string;
    timeZone?: string;
    maxHorizonDays?: number;
  }): Promise<NextSlot[]> {
    return this.engine.getNextSlots({
      candidates,
      limit,
      after: after ? new Date(after) : undefined,
      timeZone,
      maxHorizonDays,
    });
  }

  private async resolveEventType(query: GetNextSlotsInput_2024_09_04) {
    if (query.eventTypeId) {
      const eventType = await this.eventTypesRepository.getEventTypeById(query.eventTypeId);
      if (!eventType) throw new NotFoundException(`Event Type with ID=${query.eventTypeId} not found`);
      return eventType;
    }

    if (!query.username || !query.eventTypeSlug) {
      throw new BadRequestException("Provide either 'eventTypeId', or both 'username' and 'eventTypeSlug'.");
    }

    const user = await this.usersRepository.findByUsername(query.username);
    if (!user) throw new NotFoundException(`User with username ${query.username} not found`);

    const eventType = await this.eventTypesRepository.getUserEventTypeBySlug(user.id, query.eventTypeSlug);
    if (!eventType) {
      throw new NotFoundException(
        `Event Type with slug ${query.eventTypeSlug} not found for user ${query.username}`
      );
    }
    return eventType;
  }
}
