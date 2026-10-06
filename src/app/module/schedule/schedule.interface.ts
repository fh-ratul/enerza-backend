import type { z } from "zod";
import type { ScheduleValidation } from "./schedule.validation";

export type ICreateSchedulePayload = z.infer<
	typeof ScheduleValidation.CreateScheduleZodSchema
>;
