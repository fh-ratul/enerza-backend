import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import {
	validateQuery,
	validateRequest,
} from "../../middleware/validateRequest";
import { BillController } from "./bill.controller";
import { BillValidation } from "./bill.validation";

const router = Router();

router.post(
	"/",
	auth(Role.ADMIN),
	validateRequest(BillValidation.CreateBillZodSchema),
	BillController.createBill,
);

// Admin: all bills. Customer: their own. Both with payments and `isOverdue`.
router.get(
	"/",
	auth(Role.CUSTOMER, Role.ADMIN),
	validateQuery(BillValidation.BillListQueryZodSchema),
	BillController.getBills,
);

export const BillRoutes = router;
