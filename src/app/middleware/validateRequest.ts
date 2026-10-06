import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import { catchAsync } from "../utils/catchAsync";

// Each validator throws the ZodError itself, so globalErrorHandler can report
// every issue (not just the first one) in the standard `errors` array.

export const validateRequest = (zodSchema: z.ZodType) => {
	return catchAsync(
		async (req: Request, _res: Response, next: NextFunction) => {
			req.body = await zodSchema.parseAsync(req.body ?? {});

			next();
		},
	);
};

export const validateQuery = (zodSchema: z.ZodType) => {
	return catchAsync(
		async (req: Request, _res: Response, next: NextFunction) => {
			const parsed = await zodSchema.parseAsync(req.query);

			// Express 5 exposes req.query as a read-only getter, so it has to be redefined.
			Object.defineProperty(req, "query", {
				value: parsed,
				writable: true,
				configurable: true,
				enumerable: true,
			});

			next();
		},
	);
};

export const validateParams = (zodSchema: z.ZodType) => {
	return catchAsync(
		async (req: Request, _res: Response, next: NextFunction) => {
			req.params = (await zodSchema.parseAsync(
				req.params,
			)) as Request["params"];

			next();
		},
	);
};
