import { z } from "zod";
import { OutagePriority, OutageStatus } from "../../../generated/prisma/enums";
import {
	fromDateSchema,
	paginationQueryShape,
	toDateSchema,
} from "../../utils/commonValidation";
import { OUTAGE_SORTABLE_FIELDS } from "./outage.constant";

// One body for both callers. Which of them may send `feederId` is enforced in
// the service, where the caller's role is known:
//   customer → { description }            the feeder comes from their own area
//   admin    → { description, feederId }  an incident logged by the control room
const CreateOutageZodSchema = z
	.object({
		description: z
			.string("description is required")
			.trim()
			.min(5, "description must be at least 5 characters long")
			.max(500, "description cannot be longer than 500 characters"),
		feederId: z.uuid("feederId must be a valid id").optional(),
	})
	.strict();

// Every role uses the same filters; the service narrows the result to what
// the caller may see (admin: all, technician: assigned, customer: reported).
const OutageListQueryZodSchema = z
	.object({
		...paginationQueryShape,
		sortBy: z
			.enum(
				OUTAGE_SORTABLE_FIELDS,
				`sortBy must be one of: ${OUTAGE_SORTABLE_FIELDS.join(", ")}`,
			)
			.optional(),
		status: z
			.enum(
				OutageStatus,
				"status must be REPORTED, ASSIGNED, IN_PROGRESS, RESOLVED or CANCELLED",
			)
			.optional(),
		priority: z
			.enum(OutagePriority, "priority must be LOW, MEDIUM, HIGH or URGENT")
			.optional(),
		feederId: z.uuid("feederId must be a valid id").optional(),
		zoneId: z.uuid("zoneId must be a valid id").optional(),
		// outages that started in [from, to); a bare date means that whole Dhaka day
		from: fromDateSchema.optional(),
		to: toDateSchema.optional(),
	})
	.refine((query) => !query.from || !query.to || query.from < query.to, {
		path: ["to"],
		message: "to must be after from",
	});

export const OutageValidation = {
	CreateOutageZodSchema,
	OutageListQueryZodSchema,
};
