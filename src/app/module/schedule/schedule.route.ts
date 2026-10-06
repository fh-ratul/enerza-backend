import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import {
	validateParams,
	validateQuery,
	validateRequest,
} from "../../middleware/validateRequest";
import { IdParamZodSchema } from "../../utils/commonValidation";
import { ScheduleController } from "./schedule.controller";
import { ScheduleValidation } from "./schedule.validation";

const router = Router();

router.post(
	"/",
	auth(Role.ADMIN),
	validateRequest(ScheduleValidation.CreateScheduleZodSchema),
	ScheduleController.createSchedules,
);

// Static path: declared before the `/:id` routes.
router.post(
	"/generate",
	auth(Role.ADMIN),
	validateRequest(ScheduleValidation.GenerateScheduleZodSchema),
	ScheduleController.generateSchedules,
);

// Admin: every schedule, with filters. Customer: the published upcoming and
// ongoing schedules of their own feeder.
router.get(
	"/",
	auth(Role.CUSTOMER, Role.ADMIN),
	validateQuery(ScheduleValidation.ScheduleListQueryZodSchema),
	ScheduleController.getSchedules,
);

router.patch(
	"/:id/status",
	auth(Role.ADMIN),
	validateParams(IdParamZodSchema),
	validateRequest(ScheduleValidation.UpdateScheduleStatusZodSchema),
	ScheduleController.updateScheduleStatus,
);

export const ScheduleRoutes = router;
