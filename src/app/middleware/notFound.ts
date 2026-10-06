import type { Request, Response } from "express";
import httpStatus from "http-status";

export const notFound = (req: Request, res: Response) => {
	const message = `Route not found: ${req.method} ${req.originalUrl.split("?")[0]}`;

	res.status(httpStatus.NOT_FOUND).json({
		success: false,
		statusCode: httpStatus.NOT_FOUND,
		message,
		errors: [{ path: req.originalUrl.split("?")[0], message }],
	});
};
