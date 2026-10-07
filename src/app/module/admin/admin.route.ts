import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import { validateQuery } from "../../middleware/validateRequest";
import { AdminController } from "./admin.controller";
import { AdminValidation } from "./admin.validation";

const router = Router();

router.get("/stats", auth(Role.ADMIN), AdminController.getStats);

router.get(
	"/audit-logs",
	auth(Role.ADMIN),
	validateQuery(AdminValidation.AuditLogListQueryZodSchema),
	AdminController.getAuditLogs,
);

export const AdminRoutes = router;
