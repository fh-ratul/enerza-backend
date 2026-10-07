import type { z } from "zod";
import type { BillValidation } from "./bill.validation";

export type ICreateBillPayload = z.infer<
	typeof BillValidation.CreateBillZodSchema
>;

export type IBillListQuery = z.infer<
	typeof BillValidation.BillListQueryZodSchema
>;
