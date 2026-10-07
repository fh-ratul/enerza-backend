import type { z } from "zod";
import type { OutageValidation } from "./outage.validation";

export type ICreateOutagePayload = z.infer<
	typeof OutageValidation.CreateOutageZodSchema
>;
