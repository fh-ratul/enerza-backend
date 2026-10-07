import { z } from "zod";
import { BillStatus } from "../../../generated/prisma/enums";
import {
	paginationQueryShape,
	queryBooleanSchema,
} from "../../utils/commonValidation";
import { MONTH_REGEX } from "../../utils/time";
import { BILL_SORTABLE_FIELDS } from "./bill.constant";

const billingMonthSchema = z
	.string("billingMonth is required")
	.trim()
	.regex(MONTH_REGEX, "billingMonth must be a month such as 2026-09");

const CreateBillZodSchema = z
	.object({
		customerId: z.uuid("customerId must be a valid id"),
		billingMonth: billingMonthSchema,
		// the meter reading in kWh; consumption is worked out from the last one
		currentReading: z
			.number("currentReading must be a number")
			.int("currentReading must be a whole number")
			.min(0, "currentReading cannot be negative")
			.max(99_999_999, "currentReading is too large"),
	})
	.strict();

// A customer always gets their own bills, so `customerId` only matters for an
// admin.
const BillListQueryZodSchema = z.object({
	...paginationQueryShape,
	sortBy: z
		.enum(
			BILL_SORTABLE_FIELDS,
			`sortBy must be one of: ${BILL_SORTABLE_FIELDS.join(", ")}`,
		)
		.optional(),
	status: z
		.enum(BillStatus, "status must be UNPAID, PAID or CANCELLED")
		.optional(),
	billingMonth: billingMonthSchema.optional(),
	customerId: z.uuid("customerId must be a valid id").optional(),
	// true: unpaid and past the due date. false: everything else.
	overdue: queryBooleanSchema.optional(),
});

export const BillValidation = {
	CreateBillZodSchema,
	BillListQueryZodSchema,
};
