import type { z } from "zod";
import type { PaymentValidation } from "./payment.validation";

export type IBkashCallbackQuery = z.infer<
	typeof PaymentValidation.BkashCallbackQueryZodSchema
>;

export type IInitiatePaymentPayload = z.infer<
	typeof PaymentValidation.InitiatePaymentZodSchema
>;
