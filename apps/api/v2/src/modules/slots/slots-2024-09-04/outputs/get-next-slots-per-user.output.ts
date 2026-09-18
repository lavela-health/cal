import { ApiResponseWithoutData, NextSlotsForUser_2024_09_04 } from "@calcom/platform-types";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ValidateNested } from "class-validator";

export class GetNextSlotsPerUserOutput_2024_09_04 extends ApiResponseWithoutData {
  @ApiProperty({ type: [NextSlotsForUser_2024_09_04] })
  @ValidateNested({ each: true })
  @Type(() => NextSlotsForUser_2024_09_04)
  data!: NextSlotsForUser_2024_09_04[];
}
