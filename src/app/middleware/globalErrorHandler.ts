import type { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client";
import config from "../config";
import type { TErrorSource } from "../interfaces";
import { AppError } from "../utils/AppError";

const JWT_ERROR_NAMES = [
	"JsonWebTokenError",
	"TokenExpiredError",
	"NotBeforeError",
];

const zodIssuesToErrors = (error: ZodError): TErrorSource[] =>
	error.issues.flatMap((issue) => {
		// A strict object reports all unknown keys in one issue: split them up
		// so every offending field gets its own entry.
		if (issue.code === "unrecognized_keys") {
			return issue.keys.map((key) => ({
				path: [...issue.path, key].join("."),
				message: "Unknown field",
			}));
		}

		return [{ path: issue.path.join("."), message: issue.message }];
	});

// With a driver adapter the violated columns live under driverAdapterError
// instead of the classic `meta.target`.
const getUniqueFields = (
	meta: Record<string, unknown> | undefined,
): string[] => {
	const target = meta?.target;

	if (Array.isArray(target)) {
		return target.map(String);
	}
	if (typeof target === "string") {
		return [target];
	}

	const adapterError = meta?.driverAdapterError as
		| {
				cause?: {
					table?: unknown;
					constraint?: { fields?: unknown; index?: unknown };
				};
		  }
		| undefined;
	const cause = adapterError?.cause;
	const fields = cause?.constraint?.fields;

	if (Array.isArray(fields)) {
		return fields.map((field) => String(field).replaceAll('"', ""));
	}

	// The pg adapter reports the index instead of its columns. Prisma names
	// unique indexes "<table>_<field>_<field>_key", e.g. "users_email_key".
	const index = cause?.constraint?.index;

	if (typeof index !== "string" || !index.endsWith("_key")) {
		return [];
	}

	const prefix = typeof cause?.table === "string" ? `${cause.table}_` : "";
	const columns = index
		.slice(index.startsWith(prefix) ? prefix.length : 0)
		.slice(0, -"_key".length);

	return columns ? columns.split("_") : [];
};

export const globalErrorHandler = (
	err: unknown,
	_req: Request,
	res: Response,
	_next: NextFunction,
) => {
	let statusCode: number = httpStatus.INTERNAL_SERVER_ERROR;
	let message = "Internal Server Error";
	let errors: TErrorSource[] = [];
	// Only errors we do not recognise are masked in production.
	let isUnexpected = false;

	if (err instanceof ZodError) {
		statusCode = httpStatus.BAD_REQUEST;
		message = "Validation failed";
		errors = zodIssuesToErrors(err);
	} else if (err instanceof AppError) {
		statusCode = err.statusCode;
		message = err.message;
		errors = err.errors;
	} else if (err instanceof Prisma.PrismaClientKnownRequestError) {
		if (err.code === "P2002") {
			const fields = getUniqueFields(err.meta);

			statusCode = httpStatus.CONFLICT;
			message = fields.length
				? `A record with this ${fields.join(", ")} already exists`
				: "A record with these values already exists";
			errors = fields.map((field) => ({
				path: field,
				message: `${field} must be unique`,
			}));
		} else if (err.code === "P2025") {
			statusCode = httpStatus.NOT_FOUND;
			message = "The requested record was not found";
		} else if (err.code === "P2003") {
			statusCode = httpStatus.BAD_REQUEST;
			message = "A referenced record does not exist or is still in use";
		} else if (err.code === "P2034") {
			statusCode = httpStatus.CONFLICT;
			message = "The request conflicted with another one. Please try again";
		} else {
			isUnexpected = true;
		}
	} else if (err instanceof Prisma.PrismaClientValidationError) {
		statusCode = httpStatus.BAD_REQUEST;
		message = "Invalid data was sent to the database";
	} else if (err instanceof Prisma.PrismaClientInitializationError) {
		statusCode = httpStatus.SERVICE_UNAVAILABLE;
		message = "The database is currently unavailable";
	} else if (err instanceof Error && JWT_ERROR_NAMES.includes(err.name)) {
		statusCode = httpStatus.UNAUTHORIZED;
		message =
			err.name === "TokenExpiredError"
				? "Token has expired. Please log in again"
				: "Invalid token. Please log in again";
	} else if (isBodyParserError(err)) {
		// express.json() failures: malformed JSON, payload too large, …
		statusCode = err.status;
		message =
			err.type === "entity.parse.failed"
				? "Request body is not valid JSON"
				: err.type === "entity.too.large"
					? "Request body is too large"
					: "Request body could not be read";
	} else {
		isUnexpected = true;
	}

	if (isUnexpected) {
		console.error("Unhandled error:", err);

		if (!config.is_production && err instanceof Error) {
			message = err.message || message;
		}
	}

	if (errors.length === 0) {
		errors = [{ path: "", message }];
	}

	res.status(statusCode).json({
		success: false,
		statusCode,
		message,
		errors,
		stack:
			config.is_development && err instanceof Error ? err.stack : undefined,
	});
};

type TBodyParserError = Error & { status: number; type: string };

const isBodyParserError = (err: unknown): err is TBodyParserError =>
	err instanceof Error &&
	typeof (err as TBodyParserError).type === "string" &&
	typeof (err as TBodyParserError).status === "number" &&
	(err as TBodyParserError).status >= 400 &&
	(err as TBodyParserError).status < 500;
