import type { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { AppError } from "../utils/AppError";

// Runs after multer on routes that accept a file. Form fields are always
// strings, so a multipart request may carry its JSON body in one field named
// `data` (e.g. data = {"isAvailable": false}); that becomes req.body and is
// then validated exactly like a normal JSON request. Plain text fields, and
// ordinary JSON requests, pass through untouched.
export const parseFormData = (
	req: Request,
	_res: Response,
	next: NextFunction,
) => {
	const data = req.body?.data;

	if (!req.is("multipart/form-data") || typeof data !== "string") {
		return next();
	}

	try {
		const parsed: unknown = JSON.parse(data);

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error("not an object");
		}

		req.body = parsed;
		next();
	} catch {
		next(
			new AppError(
				httpStatus.BAD_REQUEST,
				"The data field must contain a JSON object",
				[{ path: "data", message: "Invalid JSON" }],
			),
		);
	}
};
