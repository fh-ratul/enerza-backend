import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import { paymentLimiter } from "../../middleware/rateLimiter";
import { validateRequest } from "../../middleware/validateRequest";
import { PaymentController } from "./payment.controller";
import { PaymentValidation } from "./payment.validation";

const router = Router();

// The limiter runs after auth so that it counts per customer, not per IP.
router.post(
	"/initiate",
	auth(Role.CUSTOMER),
	paymentLimiter,
	validateRequest(PaymentValidation.InitiatePaymentZodSchema),
	PaymentController.initiatePayment,
);

export const PaymentRoutes = router;
