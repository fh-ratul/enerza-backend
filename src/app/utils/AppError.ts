import type { TErrorSource } from "../interfaces";

export class AppError extends Error {
	public statusCode: number;
	public errors: TErrorSource[];

	constructor(
		statusCode: number,
		message: string,
		errors: TErrorSource[] = [],
	) {
		super(message);

		this.name = "AppError";
		this.statusCode = statusCode;
		this.errors = errors;

		Error.captureStackTrace(this, this.constructor);
	}
}

// throw new AppError(httpStatus.NOT_FOUND, "Feeder not found")
