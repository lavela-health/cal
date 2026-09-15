import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, ValidateNested } from "class-validator";

export class NextSlotUser_2024_09_04 {
  @ApiProperty({ description: "ID of the user who owns the event type." })
  @IsInt()
  id!: number;

  @ApiProperty({ description: "Username of the user who owns the event type.", nullable: true })
  @IsString()
  username!: string | null;

  @ApiProperty({ description: "Name of the user who owns the event type.", nullable: true })
  @IsString()
  name!: string | null;
}

export class NextSlot_2024_09_04 {
  @ApiProperty({ description: "Start time of the slot." })
  @IsDateString()
  start!: string;

  @ApiProperty({ description: "End time of the slot." })
  @IsDateString()
  end!: string;

  @ApiProperty({ description: "Duration of the slot in minutes." })
  @IsInt()
  duration!: number;

  @ApiProperty({ description: "ID of the event type this slot belongs to." })
  @IsInt()
  eventTypeId!: number;

  @ApiProperty({ description: "Slug of the event type this slot belongs to." })
  @IsString()
  eventTypeSlug!: string;

  @ApiPropertyOptional({
    type: NextSlotUser_2024_09_04,
    description: "The user this slot is bookable with. Only returned by the OAuth client endpoint.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => NextSlotUser_2024_09_04)
  user?: NextSlotUser_2024_09_04;
}
