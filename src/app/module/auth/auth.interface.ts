import type { z } from "zod";
import type { AuthValidation } from "./auth.validation";

export type IRegisterPayload = z.infer<typeof AuthValidation.RegisterZodSchema>;

export type ILoginPayload = z.infer<typeof AuthValidation.LoginZodSchema>;

export type IRefreshTokenPayload = z.infer<
	typeof AuthValidation.RefreshTokenZodSchema
>;

export type IGoogleLoginPayload = z.infer<
	typeof AuthValidation.GoogleLoginZodSchema
>;
