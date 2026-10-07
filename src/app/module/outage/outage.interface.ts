import type { z } from "zod";
import type { OutageValidation } from "./outage.validation";

export type ICreateOutagePayload = z.infer<
	typeof OutageValidation.CreateOutageZodSchema
>;

export type IUpdateOutageStatusPayload = z.infer<
	typeof OutageValidation.UpdateOutageStatusZodSchema
>;

export type IOutageListQuery = z.infer<
	typeof OutageValidation.OutageListQueryZodSchema
>;
