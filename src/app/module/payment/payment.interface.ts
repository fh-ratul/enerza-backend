import type { z } from "zod";
import type { PaymentValidation } from "./payment.validation";

export type IInitiatePaymentPayload = z.infer<
	typeof PaymentValidation.InitiatePaymentZodSchema
>;
