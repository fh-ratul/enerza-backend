import { Router } from "express";
import { authLimiter } from "../../middleware/rateLimiter";
import { validateRequest } from "../../middleware/validateRequest";
import { AuthController } from "./auth.controller";
import { AuthValidation } from "./auth.validation";

const router = Router();

router.post(
	"/register",
	authLimiter,
	validateRequest(AuthValidation.RegisterZodSchema),
	AuthController.register,
);

router.post(
	"/login",
	authLimiter,
	validateRequest(AuthValidation.LoginZodSchema),
	AuthController.login,
);

router.post(
	"/refresh-token",
	validateRequest(AuthValidation.RefreshTokenZodSchema),
	AuthController.refreshToken,
);

export const AuthRoutes = router;
