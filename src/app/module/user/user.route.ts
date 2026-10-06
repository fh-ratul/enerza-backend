import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import {
	validateParams,
	validateQuery,
	validateRequest,
} from "../../middleware/validateRequest";
import { IdParamZodSchema } from "../../utils/commonValidation";
import { UserController } from "./user.controller";
import { UserValidation } from "./user.validation";

const router = Router();

// Static `/me` routes are declared before any `/:id` route.
router.get(
	"/me",
	auth(Role.CUSTOMER, Role.TECHNICIAN, Role.ADMIN),
	UserController.getMyProfile,
);

router.patch(
	"/me",
	auth(Role.CUSTOMER, Role.TECHNICIAN, Role.ADMIN),
	validateRequest(UserValidation.UpdateMyProfileZodSchema),
	UserController.updateMyProfile,
);

router.get(
	"/",
	auth(Role.ADMIN),
	validateQuery(UserValidation.UserListQueryZodSchema),
	UserController.getAllUsers,
);

router.patch(
	"/:id",
	auth(Role.ADMIN),
	validateParams(IdParamZodSchema),
	validateRequest(UserValidation.UpdateUserZodSchema),
	UserController.updateUser,
);

export const UserRoutes = router;
