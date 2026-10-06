import type { z } from "zod";
import type { ScheduleValidation } from "./schedule.validation";

export type ICreateSchedulePayload = z.infer<
	typeof ScheduleValidation.CreateScheduleZodSchema
>;

export type IScheduleListQuery = z.infer<
	typeof ScheduleValidation.ScheduleListQueryZodSchema
>;

export type IUpdateScheduleStatusPayload = z.infer<
	typeof ScheduleValidation.UpdateScheduleStatusZodSchema
>;
