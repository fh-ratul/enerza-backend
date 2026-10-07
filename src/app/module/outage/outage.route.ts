import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import {
	validateParams,
	validateQuery,
	validateRequest,
} from "../../middleware/validateRequest";
import { IdParamZodSchema } from "../../utils/commonValidation";
import { OutageController } from "./outage.controller";
import { OutageValidation } from "./outage.validation";

const router = Router();

// Customer: report a power cut. Admin: log an incident on a feeder.
router.post(
	"/",
	auth(Role.CUSTOMER, Role.ADMIN),
	validateRequest(OutageValidation.CreateOutageZodSchema),
	OutageController.createOutage,
);

// Admin: all outages. Technician: assigned to them. Customer: reported by them.
router.get(
	"/",
	auth(Role.CUSTOMER, Role.TECHNICIAN, Role.ADMIN),
	validateQuery(OutageValidation.OutageListQueryZodSchema),
	OutageController.getOutages,
);

// Admin: assign, reassign, cancel. Assigned technician: start work, resolve.
router.patch(
	"/:id/status",
	auth(Role.TECHNICIAN, Role.ADMIN),
	validateParams(IdParamZodSchema),
	validateRequest(OutageValidation.UpdateOutageStatusZodSchema),
	OutageController.updateOutageStatus,
);

export const OutageRoutes = router;
