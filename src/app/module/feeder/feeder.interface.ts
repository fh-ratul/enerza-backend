import type { z } from "zod";
import type { FeederValidation } from "./feeder.validation";

export type ICreateFeederPayload = z.infer<
	typeof FeederValidation.CreateFeederZodSchema
>;

export type IUpdateFeederPayload = z.infer<
	typeof FeederValidation.UpdateFeederZodSchema
>;

export type IFeederListQuery = z.infer<
	typeof FeederValidation.FeederListQueryZodSchema
>;
