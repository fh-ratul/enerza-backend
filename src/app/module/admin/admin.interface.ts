import type { z } from "zod";
import type { AdminValidation } from "./admin.validation";

export type IAuditLogListQuery = z.infer<
	typeof AdminValidation.AuditLogListQueryZodSchema
>;
