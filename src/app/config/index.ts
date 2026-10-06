import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const required = (name: string) =>
	z.string(`${name} is required`).trim().min(1, `${name} is required`);

// Empty values (e.g. `REDIS_PASSWORD=`) are treated as "not set".
const optional = z
	.string()
	.trim()
	.optional()
	.transform((value) => value || undefined);

const envSchema = z.object({
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	PORT: z.coerce.number().int().min(1).max(65535).default(5000),

	DATABASE_URL: required("DATABASE_URL").regex(
		/^postgres(ql)?:\/\//,
		"DATABASE_URL must be a postgres:// connection string",
	),

	JWT_ACCESS_SECRET: required("JWT_ACCESS_SECRET").min(
		32,
		"JWT_ACCESS_SECRET must be at least 32 characters",
	),
	JWT_REFRESH_SECRET: required("JWT_REFRESH_SECRET").min(
		32,
		"JWT_REFRESH_SECRET must be at least 32 characters",
	),
	JWT_ACCESS_EXPIRES_IN: required("JWT_ACCESS_EXPIRES_IN").default("1d"),
	JWT_REFRESH_EXPIRES_IN: required("JWT_REFRESH_EXPIRES_IN").default("7d"),

	BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

	FRONTEND_URL: z.url("FRONTEND_URL must be a valid URL"),

	GOOGLE_CLIENT_ID: required("GOOGLE_CLIENT_ID"),

	ADMIN_NAME: required("ADMIN_NAME"),
	ADMIN_EMAIL: z.email("ADMIN_EMAIL must be a valid email"),
	ADMIN_PASSWORD: required("ADMIN_PASSWORD").min(
		8,
		"ADMIN_PASSWORD must be at least 8 characters",
	),

	REDIS_USER: optional,
	REDIS_PASSWORD: optional,
	REDIS_HOST: required("REDIS_HOST"),
	REDIS_PORT: z.coerce.number().int().min(1).max(65535),

	BKASH_BASE_URL: z.url("BKASH_BASE_URL must be a valid URL"),
	BKASH_USERNAME: required("BKASH_USERNAME"),
	BKASH_PASSWORD: required("BKASH_PASSWORD"),
	BKASH_APP_KEY: required("BKASH_APP_KEY"),
	BKASH_APP_SECRET: required("BKASH_APP_SECRET"),
	BKASH_CALLBACK_URL: z.url("BKASH_CALLBACK_URL must be a valid URL"),
});

const parsed = envSchema.safeParse(process.env);

// Fail fast: a half-configured server is worse than one that refuses to boot.
if (!parsed.success) {
	console.error("Invalid environment configuration:");
	for (const issue of parsed.error.issues) {
		console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
	}
	process.exit(1);
}

const env = parsed.data;

export default {
	node_env: env.NODE_ENV,
	is_production: env.NODE_ENV === "production",
	is_development: env.NODE_ENV === "development",
	port: env.PORT,
	database_url: env.DATABASE_URL,
	frontend_url: env.FRONTEND_URL,
	bcrypt_salt_rounds: env.BCRYPT_SALT_ROUNDS,
	jwt_access_secret: env.JWT_ACCESS_SECRET,
	jwt_refresh_secret: env.JWT_REFRESH_SECRET,
	jwt_access_expires_in: env.JWT_ACCESS_EXPIRES_IN,
	jwt_refresh_expires_in: env.JWT_REFRESH_EXPIRES_IN,
	google_client_id: env.GOOGLE_CLIENT_ID,
	admin_name: env.ADMIN_NAME,
	admin_email: env.ADMIN_EMAIL.toLowerCase(),
	admin_password: env.ADMIN_PASSWORD,
	redis_user: env.REDIS_USER,
	redis_password: env.REDIS_PASSWORD,
	redis_host: env.REDIS_HOST,
	redis_port: env.REDIS_PORT,
	bkash_base_url: env.BKASH_BASE_URL.replace(/\/+$/, ""),
	bkash_username: env.BKASH_USERNAME,
	bkash_password: env.BKASH_PASSWORD,
	bkash_app_key: env.BKASH_APP_KEY,
	bkash_app_secret: env.BKASH_APP_SECRET,
	bkash_callback_url: env.BKASH_CALLBACK_URL.replace(/\/+$/, ""),
};
