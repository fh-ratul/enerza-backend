import { z } from "zod";
import { ConnectionType } from "../../../generated/prisma/enums";
import {
	contactNumberSchema,
	meterNumberSchema,
} from "../../utils/commonValidation";

// Trim and lowercase first, then validate, so " User@Mail.com " is accepted
// and always stored the same way.
const emailSchema = z
	.string("Email is required")
	.trim()
	.toLowerCase()
	.pipe(z.email("Invalid email address"));

const passwordSchema = z
	.string("Password is required")
	.min(8, "Password must be at least 8 characters long")
	.max(72, "Password cannot be longer than 72 characters")
	.regex(/[a-z]/, "Password must contain at least 1 lowercase letter")
	.regex(/[A-Z]/, "Password must contain at least 1 uppercase letter")
	.regex(/[0-9]/, "Password must contain at least 1 number")
	.regex(/[^A-Za-z0-9]/, "Password must contain at least 1 special character");

const RegisterZodSchema = z
	.object({
		name: z
			.string("Name is required")
			.trim()
			.min(2, "Name must be at least 2 characters long")
			.max(60, "Name cannot be longer than 60 characters"),
		email: emailSchema,
		password: passwordSchema,
		contactNumber: contactNumberSchema.optional(),
		areaId: z.uuid("areaId must be a valid id"),
		meterNumber: meterNumberSchema,
		connectionType: z
			.enum(ConnectionType, "connectionType must be RESIDENTIAL or COMMERCIAL")
			.default(ConnectionType.RESIDENTIAL),
	})
	.strict();

const LoginZodSchema = z
	.object({
		email: emailSchema,
		password: z.string("Password is required").min(1, "Password is required"),
	})
	.strict();

// The refresh token may come from the httpOnly cookie instead of the body.
const RefreshTokenZodSchema = z
	.object({
		refreshToken: z.string().trim().min(1).optional(),
	})
	.strict();

// The ID token (credential) that Google Sign-In hands to the client.
const GoogleLoginZodSchema = z
	.object({
		idToken: z
			.string("Google ID token is required")
			.trim()
			.min(1, "Google ID token is required"),
	})
	.strict();

export const AuthValidation = {
	RegisterZodSchema,
	LoginZodSchema,
	RefreshTokenZodSchema,
	GoogleLoginZodSchema,
};
