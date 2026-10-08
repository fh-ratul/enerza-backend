import { z } from "zod";
import { Role, UserStatus } from "../../../generated/prisma/enums";
import {
	contactNumberSchema,
	meterNumberSchema,
	paginationQueryShape,
	searchTermSchema,
} from "../../utils/commonValidation";
import { USER_SORTABLE_FIELDS } from "./user.constant";

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
	// "Nothing to update" is checked in the service, where it is known
	// whether a profile photo came with the request.
	.strict();

const UserListQueryZodSchema = z.object({
	...paginationQueryShape,
	sortBy: z
		.enum(
			USER_SORTABLE_FIELDS,
			`sortBy must be one of: ${USER_SORTABLE_FIELDS.join(", ")}`,
		)
		.optional(),
	searchTerm: searchTermSchema.optional(),
	role: z.enum(Role, "role must be CUSTOMER, TECHNICIAN or ADMIN").optional(),
	status: z.enum(UserStatus, "status must be ACTIVE or BLOCKED").optional(),
});

// Admin action on another user: block/unblock (status) and/or promote a
// customer to technician (role + the zone they will work in).
const UpdateUserZodSchema = z
	.object({
		status: z.enum(UserStatus, "status must be ACTIVE or BLOCKED").optional(),
		role: z
			.literal(Role.TECHNICIAN, "role can only be changed to TECHNICIAN")
			.optional(),
		zoneId: z.uuid("zoneId must be a valid id").optional(),
	})
	.strict()
	.superRefine((body, ctx) => {
		if (body.status === undefined && body.role === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "Provide status and/or role",
			});
		}

		if (body.role !== undefined && body.zoneId === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["zoneId"],
				message: "zoneId is required when promoting a user to TECHNICIAN",
			});
		}

		if (body.role === undefined && body.zoneId !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["zoneId"],
				message: "zoneId can only be sent together with role: TECHNICIAN",
			});
		}
	});

export const UserValidation = {
	UpdateMyProfileZodSchema,
	UserListQueryZodSchema,
	UpdateUserZodSchema,
};
