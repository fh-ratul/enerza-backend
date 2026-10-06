import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import { validateRequest } from "../../middleware/validateRequest";
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

export const UserRoutes = router;
