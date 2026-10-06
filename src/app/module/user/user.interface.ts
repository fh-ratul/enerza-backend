import type { z } from "zod";
import type { UserValidation } from "./user.validation";

export type IUpdateMyProfilePayload = z.infer<
	typeof UserValidation.UpdateMyProfileZodSchema
>;
