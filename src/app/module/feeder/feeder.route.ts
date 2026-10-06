import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import {
	validateParams,
	validateQuery,
	validateRequest,
} from "../../middleware/validateRequest";
import { IdParamZodSchema } from "../../utils/commonValidation";
import { FeederController } from "./feeder.controller";
import { FeederValidation } from "./feeder.validation";

const router = Router();

router.post(
	"/",
	auth(Role.ADMIN),
	validateRequest(FeederValidation.CreateFeederZodSchema),
	FeederController.createFeeder,
);

// Public: customers browse feeders and areas before they register.
router.get(
	"/",
	validateQuery(FeederValidation.FeederListQueryZodSchema),
	FeederController.getAllFeeders,
);

router.patch(
	"/:id",
	auth(Role.ADMIN),
	validateParams(IdParamZodSchema),
	validateRequest(FeederValidation.UpdateFeederZodSchema),
	FeederController.updateFeeder,
);

router.delete(
	"/:id",
	auth(Role.ADMIN),
	validateParams(IdParamZodSchema),
	FeederController.deleteFeeder,
);

export const FeederRoutes = router;
