import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import {
	validateQuery,
	validateRequest,
} from "../../middleware/validateRequest";
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

export const OutageRoutes = router;
