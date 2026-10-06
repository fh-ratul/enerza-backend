import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import { validateRequest } from "../../middleware/validateRequest";
import { ScheduleController } from "./schedule.controller";
import { ScheduleValidation } from "./schedule.validation";

const router = Router();

router.post(
	"/",
	auth(Role.ADMIN),
	validateRequest(ScheduleValidation.CreateScheduleZodSchema),
	ScheduleController.createSchedules,
);

export const ScheduleRoutes = router;
