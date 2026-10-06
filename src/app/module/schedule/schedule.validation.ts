import { z } from "zod";
import { ScheduleType } from "../../../generated/prisma/enums";
import { dhakaDateTimeSchema } from "../../utils/commonValidation";
import { MAX_FEEDERS_PER_SCHEDULE } from "./schedule.constant";
import { getWindowError } from "./schedule.utils";

const reasonSchema = z
	.string()
	.trim()
	.min(3, "reason must be at least 3 characters long")
	.max(300, "reason cannot be longer than 300 characters");

// One request creates the same window on several feeders (one DRAFT row each).
// Times without an offset are Asia/Dhaka, e.g. "2026-10-06T19:00".
const CreateScheduleZodSchema = z
	.object({
		type: z.enum(ScheduleType, "type must be LOAD_SHEDDING or MAINTENANCE"),
		feederIds: z
			.array(
				z.uuid("each feederId must be a valid id"),
				"feederIds must be a list of feeder ids",
			)
			.min(1, "Provide at least one feederId")
			.max(
				MAX_FEEDERS_PER_SCHEDULE,
				`At most ${MAX_FEEDERS_PER_SCHEDULE} feeders per request`,
			)
			.refine(
				(ids) => new Set(ids).size === ids.length,
				"feederIds must not contain duplicates",
			),
		startTime: dhakaDateTimeSchema,
		endTime: dhakaDateTimeSchema,
		reason: reasonSchema.optional(),
	})
	.strict()
	.superRefine((body, ctx) => {
		const windowError = getWindowError(body.type, body.startTime, body.endTime);

		if (windowError) {
			ctx.addIssue({
				code: "custom",
				path: ["endTime"],
				message: windowError,
			});
		}

		if (body.startTime.getTime() <= Date.now()) {
			ctx.addIssue({
				code: "custom",
				path: ["startTime"],
				message: "startTime must be in the future",
			});
		}
	});

export const ScheduleValidation = {
	CreateScheduleZodSchema,
};
