import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import { validateRequest } from "../../middleware/validateRequest";
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

export const OutageRoutes = router;
