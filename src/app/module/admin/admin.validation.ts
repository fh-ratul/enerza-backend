import { z } from "zod";
import { AuditAction } from "../../../generated/prisma/enums";
import { AUDIT_ENTITY_TYPES } from "../../utils/auditLog";
import {
	fromDateSchema,
	paginationQueryShape,
	toDateSchema,
} from "../../utils/commonValidation";
import { AUDIT_LOG_SORTABLE_FIELDS } from "./admin.constant";

const AuditLogListQueryZodSchema = z
	.object({
		...paginationQueryShape,
		sortBy: z
			.enum(
				AUDIT_LOG_SORTABLE_FIELDS,
				`sortBy must be one of: ${AUDIT_LOG_SORTABLE_FIELDS.join(", ")}`,
			)
			.optional(),
		action: z
			.enum(
				AuditAction,
				`action must be one of: ${Object.values(AuditAction).join(", ")}`,
			)
			.optional(),
		entityType: z
			.enum(
				AUDIT_ENTITY_TYPES,
				`entityType must be one of: ${AUDIT_ENTITY_TYPES.join(", ")}`,
			)
			.optional(),
		// with entityType: the full history of one feeder, outage, bill…
		entityId: z.uuid("entityId must be a valid id").optional(),
		actorId: z.uuid("actorId must be a valid id").optional(),
		// logged in [from, to); a bare date means that whole Dhaka day
		from: fromDateSchema.optional(),
		to: toDateSchema.optional(),
	})
	.refine((query) => !query.from || !query.to || query.from < query.to, {
		path: ["to"],
		message: "to must be after from",
	});

export const AdminValidation = {
	AuditLogListQueryZodSchema,
};
