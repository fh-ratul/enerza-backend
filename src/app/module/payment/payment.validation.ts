import { z } from "zod";

const InitiatePaymentZodSchema = z
	.object({
		billId: z.uuid("billId must be a valid id"),
	})
	.strict();

// The query bKash appends when it redirects the customer back. It also sends
// a `signature`, which is not used: the payment is verified with bKash
// directly instead.
const BkashCallbackQueryZodSchema = z.object({
	paymentID: z
		.string("paymentID is required")
		.trim()
		.min(1, "paymentID is required")
		.max(100, "paymentID is too long"),
	status: z.enum(
		["success", "failure", "cancel"],
		"status must be success, failure or cancel",
	),
});

export const PaymentValidation = {
	InitiatePaymentZodSchema,
	BkashCallbackQueryZodSchema,
};
