import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { upload } from "../../lib/multer";
import { auth } from "../../middleware/checkAuth";
import { parseFormData } from "../../middleware/parseFormData";
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

// JSON, or multipart/form-data with an optional `profilePhoto` image and the
// fields either as plain form fields or as JSON in a `data` field.
router.patch(
	"/me",
	auth(Role.CUSTOMER, Role.TECHNICIAN, Role.ADMIN),
	upload.single("profilePhoto"),
	parseFormData,
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
