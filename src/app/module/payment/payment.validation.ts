import { z } from "zod";

const InitiatePaymentZodSchema = z
	.object({
		billId: z.uuid("billId must be a valid id"),
	})
	.strict();

export const PaymentValidation = {
	InitiatePaymentZodSchema,
};
