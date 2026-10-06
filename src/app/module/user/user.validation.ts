import { z } from "zod";
import {
	contactNumberSchema,
	meterNumberSchema,
} from "../../utils/commonValidation";

// One schema for every role. Which fields a role may actually change is
// enforced in the service, where the caller's role is known:
//   everyone    → name
//   customer    → contactNumber, address, areaId, meterNumber
//   technician  → contactNumber, isAvailable (on/off duty)
const UpdateMyProfileZodSchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(2, "Name must be at least 2 characters long")
			.max(60, "Name cannot be longer than 60 characters")
			.optional(),
		contactNumber: contactNumberSchema.nullable().optional(),
		address: z
			.string()
			.trim()
			.min(5, "Address must be at least 5 characters long")
			.max(200, "Address cannot be longer than 200 characters")
			.nullable()
			.optional(),
		areaId: z.uuid("areaId must be a valid id").optional(),
		meterNumber: meterNumberSchema.optional(),
		isAvailable: z.boolean("isAvailable must be true or false").optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Provide at least one field to update",
	});

export const UserValidation = {
	UpdateMyProfileZodSchema,
};
