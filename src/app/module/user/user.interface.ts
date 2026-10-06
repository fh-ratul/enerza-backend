import type { z } from "zod";
import type { UserValidation } from "./user.validation";

export type IUpdateMyProfilePayload = z.infer<
	typeof UserValidation.UpdateMyProfileZodSchema
>;

export type IUserListQuery = z.infer<
	typeof UserValidation.UserListQueryZodSchema
>;

export type IUpdateUserPayload = z.infer<
	typeof UserValidation.UpdateUserZodSchema
>;
