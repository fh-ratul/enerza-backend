import { z } from "zod";
import {
	DATE_REGEX,
	DATE_TIME_REGEX,
	dhakaDayRange,
	parseDhakaDateTime,
} from "./time";

// Zod building blocks shared by more than one module.

// `/:id` route params
export const IdParamZodSchema = z.object({
	id: z.uuid("id must be a valid id"),
});

// Query-string values always arrive as strings, hence the coercion. `limit`
// above 100 is capped by paginationHelper rather than rejected.
export const paginationQueryShape = {
	page: z.coerce
		.number("page must be a number")
		.int("page must be a whole number")
		.min(1, "page must be at least 1")
		.optional(),
	limit: z.coerce
		.number("limit must be a number")
		.int("limit must be a whole number")
		.min(1, "limit must be at least 1")
		.optional(),
	sortOrder: z
		.enum(["asc", "desc"], "sortOrder must be asc or desc")
		.optional(),
};

export const searchTermSchema = z
	.string()
	.trim()
	.min(1, "searchTerm cannot be empty")
	.max(100, "searchTerm cannot be longer than 100 characters");

// "true" / "false" in a query string → boolean
export const queryBooleanSchema = z
	.enum(["true", "false"], "must be true or false")
	.transform((value) => value === "true");

// A datetime such as "2026-10-06T16:00". Without an offset it is read as
// Asia/Dhaka time. Parsed into a Date (UTC instant).
export const dhakaDateTimeSchema = z
	.string("must be a datetime such as 2026-10-06T16:00")
	.trim()
	.regex(DATE_TIME_REGEX, "must be a datetime such as 2026-10-06T16:00")
	.transform(parseDhakaDateTime)
	.refine((date) => !Number.isNaN(date.getTime()), "must be a valid datetime");

const isRealDate = (value: string) =>
	!Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) &&
	new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

// "YYYY-MM-DD", a calendar day in Dhaka
export const dhakaDateSchema = z
	.string("must be a date such as 2026-10-06")
	.trim()
	.regex(DATE_REGEX, "must be a date such as 2026-10-06")
	.refine(isRealDate, "must be a real calendar date");

// List filters `from` / `to` accept a Dhaka date or a datetime.
// A bare date means the start of that day for `from` and its end for `to`.
const rangeBoundSchema = (edge: "start" | "end") =>
	z
		.string()
		.trim()
		.refine(
			(value) =>
				(DATE_REGEX.test(value) && isRealDate(value)) ||
				(DATE_TIME_REGEX.test(value) &&
					!Number.isNaN(parseDhakaDateTime(value).getTime())),
			{
				message: "must be a date (2026-10-06) or a datetime (2026-10-06T16:00)",
				// stop here on bad input, so later range checks never see an Invalid Date
				abort: true,
			},
		)
		.transform((value) =>
			DATE_REGEX.test(value)
				? dhakaDayRange(value)[edge]
				: parseDhakaDateTime(value),
		);

export const fromDateSchema = rangeBoundSchema("start");
export const toDateSchema = rangeBoundSchema("end");

export const contactNumberSchema = z
	.string()
	.trim()
	.regex(
		/^(\+?88)?01[3-9]\d{8}$/,
		"Contact number must be a valid Bangladeshi mobile number",
	);

export const meterNumberSchema = z
	.string("Meter number is required")
	.trim()
	.toUpperCase()
	.regex(
		/^[A-Z0-9-]{4,30}$/,
		"Meter number must be 4-30 letters, digits or hyphens",
	);
