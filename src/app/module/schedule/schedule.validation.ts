import { z } from "zod";
import { ScheduleStatus, ScheduleType } from "../../../generated/prisma/enums";
import {
	dhakaDateSchema,
	dhakaDateTimeSchema,
	fromDateSchema,
	paginationQueryShape,
	toDateSchema,
} from "../../utils/commonValidation";
import { dhakaDateAtHour } from "../../utils/time";
import {
	GENERATOR_SLOT_MINUTES,
	MAX_FEEDERS_PER_SCHEDULE,
	SCHEDULE_PHASES,
	SCHEDULE_SORTABLE_FIELDS,
} from "./schedule.constant";
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

// Admins can use every filter. For customers the filters are ignored: they
// always get the published upcoming/ongoing schedules of their own feeder.
const ScheduleListQueryZodSchema = z
	.object({
		...paginationQueryShape,
		sortBy: z
			.enum(
				SCHEDULE_SORTABLE_FIELDS,
				`sortBy must be one of: ${SCHEDULE_SORTABLE_FIELDS.join(", ")}`,
			)
			.optional(),
		type: z
			.enum(ScheduleType, "type must be LOAD_SHEDDING or MAINTENANCE")
			.optional(),
		status: z
			.enum(ScheduleStatus, "status must be DRAFT, PUBLISHED or CANCELLED")
			.optional(),
		phase: z
			.enum(SCHEDULE_PHASES, "phase must be UPCOMING, ONGOING or COMPLETED")
			.optional(),
		feederId: z.uuid("feederId must be a valid id").optional(),
		zoneId: z.uuid("zoneId must be a valid id").optional(),
		// schedules that overlap [from, to); a bare date means that whole Dhaka day
		from: fromDateSchema.optional(),
		to: toDateSchema.optional(),
	})
	.refine((query) => !query.from || !query.to || query.from < query.to, {
		path: ["to"],
		message: "to must be after from",
	});

// DRAFT → PUBLISHED, DRAFT → CANCELLED or PUBLISHED → CANCELLED.
// `reason` is the cancellation reason (required when cancelling a published schedule).
const UpdateScheduleStatusZodSchema = z
	.object({
		status: z.enum(
			[ScheduleStatus.PUBLISHED, ScheduleStatus.CANCELLED],
			"status must be PUBLISHED or CANCELLED",
		),
		reason: reasonSchema.optional(),
	})
	.strict();

// Automated rotation for one Dhaka day, e.g. 18:00–22:00 in 60-minute slots,
// shedding `deficitMW` in every slot. `dryRun` defaults to true: the plan is
// only saved when the admin explicitly sends `dryRun: false`.
const GenerateScheduleZodSchema = z
	.object({
		zoneId: z.uuid("zoneId must be a valid id").optional(),
		substationId: z.uuid("substationId must be a valid id").optional(),
		date: dhakaDateSchema,
		startHour: z
			.number("startHour must be a number")
			.int("startHour must be a whole hour")
			.min(0, "startHour must be between 0 and 23")
			.max(23, "startHour must be between 0 and 23"),
		endHour: z
			.number("endHour must be a number")
			.int("endHour must be a whole hour")
			.min(1, "endHour must be between 1 and 24")
			.max(24, "endHour must be between 1 and 24"),
		slotMinutes: z.literal(
			[...GENERATOR_SLOT_MINUTES],
			`slotMinutes must be one of: ${GENERATOR_SLOT_MINUTES.join(", ")}`,
		),
		deficitMW: z
			.number("deficitMW must be a number")
			.positive("deficitMW must be greater than 0")
			.max(1000, "deficitMW cannot exceed 1000")
			.refine(
				(value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
				"deficitMW can have at most 2 decimal places",
			),
		dryRun: z.boolean("dryRun must be true or false").default(true),
	})
	.strict()
	.superRefine((body, ctx) => {
		// The scope is exactly one zone or one substation.
		if (Boolean(body.zoneId) === Boolean(body.substationId)) {
			ctx.addIssue({
				code: "custom",
				path: [body.zoneId ? "substationId" : "zoneId"],
				message: "Provide exactly one of zoneId or substationId",
			});
		}

		if (body.endHour <= body.startHour) {
			ctx.addIssue({
				code: "custom",
				path: ["endHour"],
				message: "endHour must be after startHour",
			});

			return;
		}

		if (((body.endHour - body.startHour) * 60) % body.slotMinutes !== 0) {
			ctx.addIssue({
				code: "custom",
				path: ["slotMinutes"],
				message: `The window must divide into whole ${body.slotMinutes}-minute slots`,
			});
		}

		if (dhakaDateAtHour(body.date, body.startHour).getTime() <= Date.now()) {
			ctx.addIssue({
				code: "custom",
				path: ["startHour"],
				message: "The window must start in the future (Asia/Dhaka time)",
			});
		}
	});

export const ScheduleValidation = {
	CreateScheduleZodSchema,
	ScheduleListQueryZodSchema,
	UpdateScheduleStatusZodSchema,
	GenerateScheduleZodSchema,
};
