import { z } from "zod";

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

export const OutageValidation = {
	CreateOutageZodSchema,
};
